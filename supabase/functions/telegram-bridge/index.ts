// Telegram bridge: allow-listed named queries scoped to a therapist.
// Auth: header "x-api-key" must equal TELEGRAM_BRIDGE_SECRET.
//
// Common request body:
//   {
//     "action": "<one of the supported actions>",
//     "therapist_id": "uuid",   // required for every action
//     ...action-specific params
//   }
//
// Supported actions:
//   - get_patients
//   - get_sessions               { patient_id?: uuid, limit?: number }   (returns session_summaries)
//   - get_unpaid_sessions        { month?: 1-12, year?: number }         (from payments where paid=false)
//   - get_monthly_summary        { month: 1-12, year: number }
//   - get_todays_sessions                                                (session_summaries created today, Asia/Jerusalem)
//   - get_sessions_without_summary { limit?: number }                    (payments rows with no matching summary by event_id)
//   - add_session_summary        { patient_id: uuid, event_id: string,
//                                  drive_file_id?: string, drive_file_name?: string }
//   - get_patient_balance        { patient_id: uuid }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const isUuid = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const clampLimit = (raw: unknown, def = 50, max = 200) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), 1), max);
};

// Format month string used in payments.month (e.g. "2026-05")
const monthKey = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}`;

// Today's date in Asia/Jerusalem as YYYY-MM-DD
const todayInJerusalem = () => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // en-CA gives YYYY-MM-DD
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  // Auth
  const apiKey = req.headers.get("x-api-key");
  const expected = Deno.env.get("TELEGRAM_BRIDGE_SECRET");
  if (!expected) return json(500, { error: "Server not configured" });
  if (!apiKey || apiKey !== expected) return json(401, { error: "Unauthorized" });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const action = body?.action as string | undefined;
  const therapistId = body?.therapist_id as string | undefined;

  if (!action) return json(400, { error: "Missing 'action'" });
  if (!isUuid(therapistId)) {
    return json(400, { error: "Missing or invalid 'therapist_id' (uuid)" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    switch (action) {
      // ---------------------------------------------------------------
      case "get_patients": {
        const { data, error } = await supabase
          .from("patients")
          .select(
            "id, name, phone, session_price, billing_type, mindme, parent_patient_id",
          )
          .eq("therapist_id", therapistId)
          .order("name", { ascending: true });
        if (error) throw error;
        return json(200, { patients: data ?? [] });
      }

      // ---------------------------------------------------------------
      case "get_sessions": {
        const limit = clampLimit(body?.limit, 50, 200);
        let q = supabase
          .from("session_summaries")
          .select(
            "id, patient_id, event_id, drive_file_id, drive_file_name, created_at, updated_at",
          )
          .eq("therapist_id", therapistId)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (body?.patient_id !== undefined) {
          if (!isUuid(body.patient_id)) {
            return json(400, { error: "Invalid 'patient_id' (uuid)" });
          }
          q = q.eq("patient_id", body.patient_id);
        }
        const { data, error } = await q;
        if (error) throw error;
        return json(200, { sessions: data ?? [] });
      }

      // ---------------------------------------------------------------
      case "get_unpaid_sessions": {
        // From the payments table — these are billing rows, one per
        // patient/month, with paid=false meaning still owed.
        let q = supabase
          .from("payments")
          .select(
            "id, patient_id, month, amount, session_count, paid, status, notes, updated_at",
          )
          .eq("therapist_id", therapistId)
          .eq("paid", false)
          .order("month", { ascending: false });

        if (body?.month !== undefined || body?.year !== undefined) {
          const month = Number(body?.month);
          const year = Number(body?.year);
          if (
            !Number.isInteger(month) || month < 1 || month > 12 ||
            !Number.isInteger(year) || year < 2000 || year > 2100
          ) {
            return json(400, {
              error: "When provided, 'month' (1-12) and 'year' must both be valid integers",
            });
          }
          q = q.eq("month", monthKey(year, month));
        }

        const { data, error } = await q;
        if (error) throw error;
        const total_owed = (data ?? []).reduce(
          (s, r: any) => s + Number(r.amount || 0),
          0,
        );
        return json(200, { unpaid: data ?? [], total_owed });
      }

      // ---------------------------------------------------------------
      case "get_monthly_summary": {
        const month = Number(body?.month);
        const year = Number(body?.year);
        if (
          !Number.isInteger(month) || month < 1 || month > 12 ||
          !Number.isInteger(year) || year < 2000 || year > 2100
        ) {
          return json(400, {
            error: "Missing/invalid 'month' (1-12) and 'year'",
          });
        }
        const key = monthKey(year, month);
        const { data, error } = await supabase
          .from("payments")
          .select("amount, session_count, paid")
          .eq("therapist_id", therapistId)
          .eq("month", key);
        if (error) throw error;
        const rows = data ?? [];
        const total_billed = rows.reduce((s, r: any) => s + Number(r.amount || 0), 0);
        const total_paid = rows
          .filter((r: any) => r.paid)
          .reduce((s, r: any) => s + Number(r.amount || 0), 0);
        const total_unpaid = total_billed - total_paid;
        const session_count = rows.reduce(
          (s, r: any) => s + Number(r.session_count || 0),
          0,
        );
        return json(200, {
          month: key,
          total_billed,
          total_paid,
          total_unpaid,
          session_count,
          row_count: rows.length,
        });
      }

      // ---------------------------------------------------------------
      case "get_todays_sessions": {
        // Sessions are sourced from Google Calendar at runtime in the app,
        // so the bridge cannot list calendar events without OAuth context.
        // We return session_summaries CREATED today (Asia/Jerusalem),
        // which is the closest persisted equivalent.
        const today = todayInJerusalem(); // YYYY-MM-DD
        // Day boundaries in Jerusalem expressed as ISO instants.
        // Asia/Jerusalem is UTC+2 (winter) or UTC+3 (summer); we approximate
        // with a generous window: from start-of-day UTC-3 to end-of-day UTC.
        const startUtc = new Date(`${today}T00:00:00+03:00`).toISOString();
        const endUtc = new Date(`${today}T23:59:59+02:00`).toISOString();

        const { data, error } = await supabase
          .from("session_summaries")
          .select(
            "id, patient_id, event_id, drive_file_id, drive_file_name, created_at",
          )
          .eq("therapist_id", therapistId)
          .gte("created_at", startUtc)
          .lte("created_at", endUtc)
          .order("created_at", { ascending: false });
        if (error) throw error;
        return json(200, {
          date: today,
          note:
            "Calendar events are not stored in DB; this returns session_summaries created today.",
          sessions: data ?? [],
        });
      }

      // ---------------------------------------------------------------
      case "get_sessions_without_summary": {
        // Heuristic: payments rows for this therapist that have
        // paid_event_ids whose event_ids do NOT appear in session_summaries.
        const limit = clampLimit(body?.limit, 50, 200);

        const { data: payRows, error: payErr } = await supabase
          .from("payments")
          .select("id, patient_id, month, paid_event_ids")
          .eq("therapist_id", therapistId);
        if (payErr) throw payErr;

        const { data: sumRows, error: sumErr } = await supabase
          .from("session_summaries")
          .select("event_id")
          .eq("therapist_id", therapistId);
        if (sumErr) throw sumErr;

        const summarized = new Set(
          (sumRows ?? []).map((r: any) => r.event_id).filter(Boolean),
        );

        const missing: Array<{
          patient_id: string;
          event_id: string;
          month: string;
        }> = [];
        for (const p of payRows ?? []) {
          const ids: string[] = Array.isArray((p as any).paid_event_ids)
            ? (p as any).paid_event_ids
            : [];
          for (const eid of ids) {
            if (eid && !summarized.has(eid)) {
              missing.push({
                patient_id: (p as any).patient_id,
                event_id: eid,
                month: (p as any).month,
              });
              if (missing.length >= limit) break;
            }
          }
          if (missing.length >= limit) break;
        }

        return json(200, { missing_summaries: missing, count: missing.length });
      }

      // ---------------------------------------------------------------
      case "add_session_summary": {
        const patientId = body?.patient_id;
        const eventId = body?.event_id;
        if (!isUuid(patientId)) {
          return json(400, { error: "Missing or invalid 'patient_id' (uuid)" });
        }
        if (typeof eventId !== "string" || !eventId.trim()) {
          return json(400, { error: "Missing 'event_id' (string)" });
        }

        // Verify patient ownership
        const { data: patient, error: pErr } = await supabase
          .from("patients")
          .select("id")
          .eq("id", patientId)
          .eq("therapist_id", therapistId)
          .maybeSingle();
        if (pErr) throw pErr;
        if (!patient) {
          return json(404, { error: "Patient not found for this therapist" });
        }

        const row = {
          therapist_id: therapistId,
          patient_id: patientId,
          event_id: eventId.trim(),
          drive_file_id:
            typeof body?.drive_file_id === "string" ? body.drive_file_id : null,
          drive_file_name:
            typeof body?.drive_file_name === "string"
              ? body.drive_file_name
              : null,
        };

        const { data, error } = await supabase
          .from("session_summaries")
          .insert(row)
          .select(
            "id, patient_id, event_id, drive_file_id, drive_file_name, created_at",
          )
          .single();
        if (error) throw error;
        return json(200, { session_summary: data });
      }

      // ---------------------------------------------------------------
      case "get_patient_balance": {
        const patientId = body?.patient_id;
        if (!isUuid(patientId)) {
          return json(400, { error: "Missing or invalid 'patient_id' (uuid)" });
        }
        // Verify ownership
        const { data: patient, error: pErr } = await supabase
          .from("patients")
          .select("id, name")
          .eq("id", patientId)
          .eq("therapist_id", therapistId)
          .maybeSingle();
        if (pErr) throw pErr;
        if (!patient) {
          return json(404, { error: "Patient not found for this therapist" });
        }

        const { data: pays, error: payErr } = await supabase
          .from("payments")
          .select("amount, paid")
          .eq("therapist_id", therapistId)
          .eq("patient_id", patientId);
        if (payErr) throw payErr;

        const total_billed = (pays ?? []).reduce(
          (s, r: any) => s + Number(r.amount || 0),
          0,
        );
        const total_paid = (pays ?? [])
          .filter((r: any) => r.paid)
          .reduce((s, r: any) => s + Number(r.amount || 0), 0);
        const total_owed = total_billed - total_paid;

        // Include manual debts as well
        const { data: debts, error: dErr } = await supabase
          .from("manual_debts")
          .select("amount")
          .eq("therapist_id", therapistId)
          .eq("patient_id", patientId);
        if (dErr) throw dErr;
        const manual_debt = (debts ?? []).reduce(
          (s, r: any) => s + Number(r.amount || 0),
          0,
        );

        return json(200, {
          patient_id: patientId,
          patient_name: (patient as any).name,
          total_billed,
          total_paid,
          total_owed: total_owed + manual_debt,
          manual_debt,
        });
      }

      // ---------------------------------------------------------------
      default:
        return json(400, {
          error: `Unknown action '${action}'`,
          supported: [
            "get_patients",
            "get_sessions",
            "get_unpaid_sessions",
            "get_monthly_summary",
            "get_todays_sessions",
            "get_sessions_without_summary",
            "add_session_summary",
            "get_patient_balance",
          ],
        });
    }
  } catch (e) {
    console.error("telegram-bridge error:", e);
    return json(500, {
      error: e instanceof Error ? e.message : "Unknown error",
    });
  }
});
