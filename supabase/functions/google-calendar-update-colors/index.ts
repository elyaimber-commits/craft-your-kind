import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Google Calendar color IDs
const DEFAULT_PAID_COLOR_ID = "3"; // Grape (purple)

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

    // Parse request body - expects eventIds array with calendar info
    const { eventIds, colorId } = await req.json();
    // colorId can be null to reset to default calendar color
    const targetColorId = colorId === null ? null : (colorId || DEFAULT_PAID_COLOR_ID);
    // eventIds format: [{ calendarId, eventId }, ...]

    if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
      return new Response(JSON.stringify({ error: 'No event IDs provided' }), {
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

    // Build patch body
    const patchBody = targetColorId === null
      ? { colorId: null }
      : { colorId: targetColorId };

    // Update events in batches to avoid Google rate limits
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 300;
    const MAX_RETRIES = 2;

    const updateEvent = async (calendarId: string, eventId: string, retries = 0): Promise<{ eventId: string; success: boolean; error?: string }> => {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?fields=id,colorId`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(patchBody),
        }
      );
      if (!res.ok) {
        const err = await res.json();
        if (err.error?.code === 403 && err.error?.errors?.[0]?.reason === 'rateLimitExceeded' && retries < MAX_RETRIES) {
          const backoff = (retries + 1) * 1000;
          await new Promise(r => setTimeout(r, backoff));
          return updateEvent(calendarId, eventId, retries + 1);
        }
        console.error(`Failed to update event ${eventId}:`, err);
        return { eventId, success: false, error: err.error?.message };
      }
      return { eventId, success: true };
    };

    const allItems = eventIds as { calendarId: string; eventId: string }[];
    const allResults: { eventId: string; success: boolean; error?: string }[] = [];

    for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
      const batch = allItems.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(({ calendarId, eventId }) => updateEvent(calendarId, eventId))
      );
      allResults.push(...batchResults);
      if (i + BATCH_SIZE < allItems.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    const updated = allResults.filter(r => r.success).length;
    const failed = allResults.length - updated;

    return new Response(JSON.stringify({ updated, failed, total: allResults.length }), {
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