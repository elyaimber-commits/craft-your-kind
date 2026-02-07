import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
    const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

    const token = authHeader.replace('Bearer ', '');
    const supabaseUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data, error: claimsError } = await supabaseUser.auth.getClaims(token);
    if (claimsError || !data?.claims) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userId = data.claims.sub;

    const { oldName, newName } = await req.json();
    if (!oldName || !newName) {
      return new Response(JSON.stringify({ error: 'oldName and newName are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get Google tokens
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: tokenData, error: tokenError } = await supabaseAdmin
      .from('google_tokens')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (tokenError || !tokenData) {
      return new Response(JSON.stringify({ error: 'not_connected' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let accessToken = tokenData.access_token;

    // Refresh token if expired
    if (new Date(tokenData.expires_at) <= new Date()) {
      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: tokenData.refresh_token,
          grant_type: 'refresh_token',
        }),
      });

      const refreshData = await refreshRes.json();
      if (!refreshRes.ok) {
        await supabaseAdmin.from('google_tokens').delete().eq('user_id', userId);
        return new Response(JSON.stringify({ error: 'not_connected' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      accessToken = refreshData.access_token;
      const newExpiresAt = new Date(Date.now() + (refreshData.expires_in || 3600) * 1000).toISOString();
      await supabaseAdmin
        .from('google_tokens')
        .update({ access_token: accessToken, expires_at: newExpiresAt })
        .eq('user_id', userId);
    }

    // Get all calendars
    const calListRes = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const calListData = await calListRes.json();
    if (!calListRes.ok) {
      return new Response(JSON.stringify({ error: 'calendar_error', message: calListData.error?.message }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Only search writable calendars (skip holidays, read-only shared calendars)
    const writableCalendars = (calListData.items || []).filter(
      (cal: any) => cal.accessRole === 'owner' || cal.accessRole === 'writer'
    );

    console.log(`Searching ${writableCalendars.length} writable calendars (of ${(calListData.items || []).length} total) for "${oldName}"`);

    // Search for master/non-recurring events (NOT singleEvents=true which explodes recurring events)
    // Patching the master recurring event once updates ALL instances (past + future)
    let updatedCount = 0;
    let failedCount = 0;

    const calendarResults = await Promise.allSettled(
      writableCalendars.map(async (cal: any) => {
        const searchRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?q=${encodeURIComponent(oldName)}&maxResults=250`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!searchRes.ok) return [];
        const searchData = await searchRes.json();
        const matched = (searchData.items || [])
          .filter((e: any) => (e.summary || '').trim() === oldName.trim())
          .map((e: any) => ({ calId: cal.id, eventId: e.id }));
        console.log(`Calendar "${cal.summary}": found ${matched.length} master events matching "${oldName}"`);
        return matched;
      })
    );

    const allEvents: { calId: string; eventId: string }[] = [];
    for (const result of calendarResults) {
      if (result.status === 'fulfilled') {
        allEvents.push(...result.value);
      }
    }

    console.log(`Total master events to rename: ${allEvents.length}`);

    // Rename all matching events in parallel (batch of 10)
    for (let i = 0; i < allEvents.length; i += 10) {
      const batch = allEvents.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async ({ calId, eventId }) => {
          const patchRes = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
            {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ summary: newName }),
            }
          );
          if (!patchRes.ok) {
            const err = await patchRes.json();
            console.error(`Failed to rename event ${eventId}:`, err);
            throw err;
          }
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') updatedCount++;
        else failedCount++;
      }
    }

    return new Response(JSON.stringify({ updated: updatedCount, failed: failedCount }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
