// Scheduled job: auto-color calendar events for ALL therapists.
// Runs hourly via pg_cron. No JWT required (uses service role internally).
//
// For each therapist with a Google token:
//   1. Fetch events from primary calendar (last 60 days .. next 30 days).
//   2. Apply the same color rules as auto-color-events.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getFreshGoogleAccessToken } from "../_shared/google-token.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CANCELLED_COLOR_ID = "4";

const computeTargetColor = (
  summarized: boolean,
  paid: boolean,
  invoiced: boolean,
  isPast: boolean,
): string | null => {
  if (summarized && paid && invoiced) return "3";
  if (summarized && paid) return "7";
  if (!summarized && paid) return "6";
  if (summarized && !paid) return "5";
  if (!summarized && !paid && isPast) return "1";
  return null;
};

async function processTherapist(
  supaService: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ updated: number; skipped: number; total: number; error?: string }> {
  try {
    const accessToken = await getFreshGoogleAccessToken(userId);

    // Window: last 60 days .. next 30 days
    const now = new Date();
    const timeMin = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const events: Array<{ id: string; colorId?: string; start?: any }> = [];
    let pageToken: string | undefined = undefined;
    do {
      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events`,
      );
      url.searchParams.set("timeMin", timeMin);
      url.searchParams.set("timeMax", timeMax);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("maxResults", "250");
      url.searchParams.set("fields", "items(id,colorId,start),nextPageToken");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const txt = await res.text();
        return { updated: 0, skipped: 0, total: 0, error: `list events ${res.status}: ${txt.slice(0, 200)}` };
      }
      const data = await res.json();
      for (const it of data.items || []) events.push(it);
      pageToken = data.nextPageToken;
    } while (pageToken);

    if (events.length === 0) return { updated: 0, skipped: 0, total: 0 };

    const eventIds = events.map((e) => e.id);

    const { data: summaries } = await supaService
      .from("session_summaries")
      .select("event_id")
      .eq("therapist_id", userId)
      .in("event_id", eventIds);
    const summarizedSet = new Set((summaries || []).map((s: any) => s.event_id));

    const { data: payments } = await supaService
      .from("payments")
      .select("paid_event_ids, external_payment_id")
      .eq("therapist_id", userId)
      .eq("paid", true);
    const paidSet = new Set<string>();
    const invoicedSet = new Set<string>();
    for (const p of payments || []) {
      const isInvoiced = !!(p as any).external_payment_id;
      for (const eid of (p as any).paid_event_ids || []) {
        paidSet.add(eid);
        if (isInvoiced) invoicedSet.add(eid);
      }
    }

    let updated = 0;
    let skipped = 0;
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 250;

    const patchOne = async (ev: { id: string; colorId?: string; start?: any }) => {
      if (ev.colorId === CANCELLED_COLOR_ID) {
        skipped++;
        return;
      }
      const startStr = ev.start?.dateTime || ev.start?.date;
      const startMs = startStr ? new Date(startStr).getTime() : NaN;
      const isPast = Number.isFinite(startMs) && startMs < Date.now();

      const target = computeTargetColor(
        summarizedSet.has(ev.id),
        paidSet.has(ev.id),
        invoicedSet.has(ev.id),
        isPast,
      );
      if ((ev.colorId || null) === target) {
        skipped++;
        return;
      }

      const patchRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(ev.id)}?fields=id,colorId`,
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
      await Promise.all(chunk.map(patchOne));
      if (i + BATCH_SIZE < events.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    return { updated, skipped, total: events.length };
  } catch (e) {
    return { updated: 0, skipped: 0, total: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supaService = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: tokens, error } = await supaService
      .from("google_tokens")
      .select("user_id");
    if (error) throw error;

    const userIds = Array.from(new Set((tokens || []).map((t: any) => t.user_id)));
    const results: Record<string, any> = {};
    for (const uid of userIds) {
      results[uid] = await processTherapist(supaService, uid);
    }

    return new Response(JSON.stringify({ therapists: userIds.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("auto-color-cron error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
