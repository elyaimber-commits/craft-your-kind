// Auto-color calendar events based on (summarized, paid) status.
// Body: { events: [{ calendarId, eventId }, ...] }
//
// Color rules (status -> Google Calendar colorId):
//   summarized     + not paid -> "5" (banana / yellow)    "summarized, awaiting payment"
//   not summarized + not paid -> null (default color)     "nothing done yet"
//   not summarized + paid     -> "6" (tangerine / orange)
//   summarized     + paid     -> "3" (grape / purple)
// Cancelled events ("4" / flamingo) are never modified.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CANCELLED_COLOR_ID = "4";

const computeTargetColor = (summarized: boolean, paid: boolean): string | null => {
  if (summarized && paid) return "3";
  if (!summarized && paid) return "6";
  if (summarized && !paid) return "5";
  return null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");

    const supaUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: claimsData, error: claimsErr } = await supaUser.auth.getClaims(token);
    if (claimsErr || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.claims.sub as string;

    const body = await req.json().catch(() => null);
    const events = (body?.events || []) as { calendarId: string; eventId: string }[];
    if (!Array.isArray(events) || events.length === 0) {
      return new Response(JSON.stringify({ updated: 0, skipped: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supaService = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const eventIds = events.map((e) => e.eventId);

    // Fetch which events have a summary
    const { data: summaries } = await supaService
      .from("session_summaries")
      .select("event_id")
      .eq("therapist_id", userId)
      .in("event_id", eventIds);
    const summarizedSet = new Set((summaries || []).map((s: any) => s.event_id));

    // Fetch which events have been paid
    const { data: payments } = await supaService
      .from("payments")
      .select("paid_event_ids")
      .eq("therapist_id", userId)
      .eq("paid", true);
    const paidSet = new Set<string>();
    for (const p of payments || []) {
      for (const eid of (p as any).paid_event_ids || []) paidSet.add(eid);
    }

    const accessToken = await getFreshGoogleAccessToken(userId);

    // Patch in batches
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 250;
    let updated = 0;
    let skipped = 0;

    const patchOne = async (calendarId: string, eventId: string) => {
      // Check current colorId — never touch cancelled
      const getRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?fields=id,colorId`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!getRes.ok) {
        skipped++;
        return;
      }
      const cur = await getRes.json();
      if (cur.colorId === CANCELLED_COLOR_ID) {
        skipped++;
        return;
      }

      const target = computeTargetColor(
        summarizedSet.has(eventId),
        paidSet.has(eventId),
      );

      if ((cur.colorId || null) === target) {
        skipped++;
        return;
      }

      const patchRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?fields=id,colorId`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ colorId: target }),
        },
      );
      if (patchRes.ok) updated++;
      else skipped++;
    };

    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const chunk = events.slice(i, i + BATCH_SIZE);
      await Promise.all(chunk.map((e) => patchOne(e.calendarId, e.eventId)));
      if (i + BATCH_SIZE < events.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    return new Response(JSON.stringify({ updated, skipped, total: events.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("auto-color-events error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
