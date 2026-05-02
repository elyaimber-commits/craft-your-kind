// Telegram bridge — server-side dashboard mirror.
//
// Auth: header "x-api-key" must equal TELEGRAM_BRIDGE_SECRET.
// All actions operate on a single therapist (DEFAULT_THERAPIST_ID env var,
// or "therapist_id" in the body). For every action that involves billing,
// this function reproduces the dashboard pipeline exactly:
//   1. Fetch Google Calendar events via the therapist's stored OAuth token.
//   2. Filter to billing events (colors "" / 5 / 3 / 6 / 7), drop cancelled (4)
//      and ignored event names (ignored_calendar_events).
//   3. Match each event to a patient (exact normalized name OR event_aliases).
//   4. Price each session: session_overrides > patient.session_price.
//      Institution parents aggregate sessions from their child patients.
//   5. Determine paid status: payments.paid_event_ids (per-event) +
//      Calendar paid colors (3 / 6 / 7).
//   6. Add manual_debts to balances.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// ---- Constants mirroring the dashboard ----
const BILLING_COLOR_IDS = new Set(["5", "3", "6", "7"]);
const CANCELLED_COLOR_ID = "4";
const PAID_COLORS = new Set(["3", "6", "7"]); // any of these means paid in calendar

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

const normalizeName = (name: string): string =>
  (name || "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/(.)\1+/g, "$1");

const monthKey = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}`;

const formatDate = (iso: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`;
};

// Current month in Asia/Jerusalem
const currentJerusalemMonth = () => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
  });
  // Returns YYYY-MM
  return fmt.format(new Date());
};

const todayInJerusalem = () => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // YYYY-MM-DD
};

// ---- Google token refresh ----
async function getFreshAccessToken(supabase: any, userId: string): Promise<string> {
  const { data: row, error } = await supabase
    .from("google_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`google_tokens lookup failed: ${error.message}`);
  if (!row) throw new Error("Google account not connected for this therapist");

  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt - Date.now() > 60_000) return row.access_token as string;

  const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: row.refresh_token as string,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  const newAccessToken = data.access_token as string;
  const newExpiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  await supabase
    .from("google_tokens")
    .update({ access_token: newAccessToken, expires_at: newExpiresAt })
    .eq("user_id", userId);
  return newAccessToken;
}

// ---- Fetch calendar events for a date range ----
async function fetchCalendarEvents(accessToken: string, startISO: string, endISO: string) {
  const calRes = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const calData = await calRes.json();
  if (!calRes.ok) throw new Error(`calendarList failed: ${JSON.stringify(calData)}`);
  const calendars = calData.items || [];

  const eventsArrays = await Promise.all(
    calendars.map(async (cal: any) => {
      try {
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
          cal.id,
        )}/events?timeMin=${encodeURIComponent(startISO)}&timeMax=${encodeURIComponent(
          endISO,
        )}&singleEvents=true&orderBy=startTime&maxResults=2500`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!r.ok) return [];
        const d = await r.json();
        return (d.items || []).map((e: any) => ({ ...e, calendarName: cal.summary, calendarId: cal.id }));
      } catch {
        return [];
      }
    }),
  );
  const all = eventsArrays.flat();
  all.sort((a: any, b: any) => {
    const av = a.start?.dateTime || a.start?.date || "";
    const bv = b.start?.dateTime || b.start?.date || "";
    return av.localeCompare(bv);
  });
  return all;
}

// ---- Build the dashboard model for a therapist + month ----
async function buildBillingForMonth(
  supabase: any,
  therapistId: string,
  yyyyMm: string, // "YYYY-MM"
) {
  const [yStr, mStr] = yyyyMm.split("-");
  const year = Number(yStr);
  const month = Number(mStr) - 1;
  const startISO = new Date(Date.UTC(year, month, 1)).toISOString();
  const endISO = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59)).toISOString();

  // Parallel DB loads
  const [
    patientsRes,
    aliasesRes,
    ignoredRes,
    overridesRes,
    paymentsRes,
    debtsRes,
  ] = await Promise.all([
    supabase
      .from("patients")
      .select(
        "id, name, phone, session_price, billing_type, parent_patient_id, mindme, commission_enabled, commission_type, commission_value",
      )
      .eq("therapist_id", therapistId),
    supabase.from("event_aliases").select("event_name, patient_id").eq("therapist_id", therapistId),
    supabase
      .from("ignored_calendar_events")
      .select("event_name")
      .eq("therapist_id", therapistId),
    supabase.from("session_overrides").select("event_id, custom_price").eq("therapist_id", therapistId),
    supabase
      .from("payments")
      .select("id, patient_id, month, amount, paid, paid_event_ids, total_billed, session_count, status")
      .eq("therapist_id", therapistId),
    supabase
      .from("manual_debts")
      .select("id, patient_id, amount, note")
      .eq("therapist_id", therapistId),
  ]);

  for (const r of [patientsRes, aliasesRes, ignoredRes, overridesRes, paymentsRes, debtsRes]) {
    if ((r as any).error) throw (r as any).error;
  }

  const patients: any[] = patientsRes.data || [];
  const aliases: any[] = aliasesRes.data || [];
  const ignored: any[] = ignoredRes.data || [];
  const overrides: any[] = overridesRes.data || [];
  const payments: any[] = paymentsRes.data || [];
  const debts: any[] = debtsRes.data || [];

  const aliasMap = new Map<string, string>();
  for (const a of aliases) aliasMap.set(normalizeName(a.event_name), a.patient_id);

  const ignoredSet = new Set(ignored.map((i) => normalizeName(i.event_name)));

  const overrideMap = new Map<string, number>();
  for (const o of overrides) overrideMap.set(o.event_id, Number(o.custom_price));

  // Calendar
  const accessToken = await getFreshAccessToken(supabase, therapistId);
  const events = await fetchCalendarEvents(accessToken, startISO, endISO);

  // Filter billing events
  const billingEvents = events.filter((e: any) => {
    const c = e.colorId;
    if (c === CANCELLED_COLOR_ID) return false;
    if (c && !BILLING_COLOR_IDS.has(c)) return false;
    if (ignoredSet.has(normalizeName(e.summary || ""))) return false;
    return true;
  });

  // Patient lookups
  const patientById = new Map(patients.map((p) => [p.id, p]));
  const childrenByParent = new Map<string, any[]>();
  for (const p of patients) {
    if (p.parent_patient_id) {
      const arr = childrenByParent.get(p.parent_patient_id) || [];
      arr.push(p);
      childrenByParent.set(p.parent_patient_id, arr);
    }
  }
  const standalone = patients.filter(
    (p) => !p.parent_patient_id || p.billing_type === "institution",
  );

  // Match events to patients (exact name or alias)
  const findMatch = (eventName: string, candidates: any[]) => {
    const n = normalizeName(eventName);
    for (const p of candidates) if (normalizeName(p.name) === n) return p;
    const id = aliasMap.get(n);
    if (id) return candidates.find((p) => p.id === id) || null;
    return null;
  };

  // Build per-patient billing rows (mirrors MonthlyBillingSummary.billingData)
  const billingByPatient = standalone
    .map((parent) => {
      const candidates =
        parent.billing_type === "institution"
          ? [parent, ...(childrenByParent.get(parent.id) || [])]
          : [parent];

      const sessions: Array<{
        eventId: string;
        date: string;
        startISO: string;
        summary: string;
        sessionPrice: number;
        colorId?: string;
        matchedPatientId: string;
        matchedPatientName: string;
      }> = [];

      for (const ev of billingEvents) {
        const matched = findMatch(ev.summary || "", candidates);
        if (!matched) continue;
        const startISO = ev.start?.dateTime || ev.start?.date || "";
        const price = overrideMap.has(ev.id)
          ? overrideMap.get(ev.id)!
          : Number(matched.session_price || 0);
        sessions.push({
          eventId: ev.id,
          date: formatDate(startISO),
          startISO,
          summary: ev.summary || "",
          sessionPrice: price,
          colorId: ev.colorId,
          matchedPatientId: matched.id,
          matchedPatientName: matched.name,
        });
      }

      const total_billed = sessions.reduce((s, x) => s + x.sessionPrice, 0);

      // Determine paid event ids:
      // (a) payments.paid_event_ids for this patient/month
      // (b) calendar paid colors (3 / 6 / 7)
      const paymentRow = payments.find(
        (p) => p.patient_id === parent.id && p.month === yyyyMm,
      );
      const dbPaidIds = new Set<string>(
        Array.isArray(paymentRow?.paid_event_ids) ? paymentRow!.paid_event_ids : [],
      );
      const paidEventIds = new Set<string>();
      for (const s of sessions) {
        if (dbPaidIds.has(s.eventId)) paidEventIds.add(s.eventId);
        else if (s.colorId && PAID_COLORS.has(s.colorId)) paidEventIds.add(s.eventId);
      }

      const total_paid = sessions
        .filter((s) => paidEventIds.has(s.eventId))
        .reduce((s, x) => s + x.sessionPrice, 0);
      const total_unpaid = total_billed - total_paid;

      return {
        patient_id: parent.id,
        patient_name: parent.name,
        billing_type: parent.billing_type,
        mindme: !!parent.mindme,
        session_count: sessions.length,
        paid_session_count: sessions.filter((s) => paidEventIds.has(s.eventId)).length,
        unpaid_session_count: sessions.filter((s) => !paidEventIds.has(s.eventId)).length,
        total_billed,
        total_paid,
        total_unpaid,
        sessions,
        unpaid_sessions: sessions
          .filter((s) => !paidEventIds.has(s.eventId))
          .map((s) => ({
            event_id: s.eventId,
            date: s.date,
            start: s.startISO,
            summary: s.summary,
            price: s.sessionPrice,
            matched_patient_name: s.matchedPatientName,
          })),
      };
    })
    .filter((b) => b.session_count > 0);

  return {
    month: yyyyMm,
    patients,
    patientById,
    debts,
    payments,
    billingByPatient,
  };
}

// =================== HTTP handler ===================
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
  const therapistId =
    (isUuid(body?.therapist_id) && body.therapist_id) ||
    Deno.env.get("DEFAULT_THERAPIST_ID") ||
    null;
  if (!action) return json(400, { error: "Missing 'action'" });
  if (!isUuid(therapistId)) {
    return json(400, {
      error:
        "Missing 'therapist_id' (uuid). Provide it in body or set DEFAULT_THERAPIST_ID secret.",
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Default month = current Jerusalem month
  const requestedMonth =
    body?.month && /^\d{4}-\d{2}$/.test(body.month)
      ? body.month
      : body?.year && body?.month_num
      ? monthKey(Number(body.year), Number(body.month_num))
      : currentJerusalemMonth();

  try {
    switch (action) {
      // ---------- Schema description (no DB call) ----------
      case "describe_schema": {
        return json(200, {
          tables: {
            patients:
              "id, name, phone, session_price, billing_type (monthly|per_session|institution), parent_patient_id (links institution children), mindme, commission_*, green_invoice_customer_id",
            event_aliases:
              "patient_id, event_name — alternate calendar names that map to a patient",
            ignored_calendar_events:
              "event_name — calendar entries to exclude from billing",
            session_overrides:
              "event_id, custom_price, note — overrides patient.session_price for one event",
            payments:
              "patient_id, month (YYYY-MM), amount, paid, paid_event_ids[] — per-month per-patient ledger; status is vestigial",
            session_summaries:
              "patient_id, event_id, drive_file_id, drive_file_name — written when a session note exists",
            manual_debts: "patient_id, amount, note — extra debt added by hand",
            google_tokens:
              "user_id (=therapist_id), access_token, refresh_token — used server-side to read Google Calendar",
          },
          billing_pipeline: [
            "Fetch Google Calendar events for the month (all calendars).",
            "Drop cancelled (color 4) and ignored event names.",
            "Match by normalized name OR event_aliases.",
            "Institution parents aggregate sessions from child patients.",
            "Price = session_overrides[event_id] || patient.session_price.",
            "Paid = event_id in payments.paid_event_ids OR colorId in (3,6,7).",
            "Balance per patient = total_billed - total_paid + manual_debts.",
          ],
          actions: {
            add_session_summary: {
              description:
                "Record that a session has been summarized (notes saved to Drive). Upserts on (therapist_id, event_id) and re-colors the calendar event to reflect summarized status.",
              body: {
                patient_id: "uuid (required)",
                event_id: "string — Google Calendar event id (required)",
                drive_file_id: "string (optional) — id returned by Drive upload",
                drive_file_name: "string (optional) — file name in Drive",
                calendar_id:
                  "string (optional, default 'primary') — calendar that contains the event; needed for the recolor step to succeed",
              },
            },
            mark_as_paid: {
              description:
                "Record a payment for a patient for a given month, mirroring the dashboard 'mark as paid' action. Upserts the payments row (one per patient/month), marks all that month's sessions as paid (paid_event_ids), and re-colors the calendar events to the paid color.",
              body: {
                patient_id: "uuid (required)",
                month: "string YYYY-MM (required)",
                amount:
                  "number (optional) — total paid; defaults to the month's total_billed for the patient",
                notes: "string (optional)",
              },
            },
          },
        });
      }

      // ---------- Patients (raw) ----------
      case "get_patients": {
        const { data, error } = await supabase
          .from("patients")
          .select(
            "id, name, phone, session_price, billing_type, parent_patient_id, mindme",
          )
          .eq("therapist_id", therapistId)
          .order("name", { ascending: true });
        if (error) throw error;
        return json(200, { patients: data ?? [] });
      }

      // ---------- Recent session_summaries (raw) ----------
      case "get_sessions": {
        const limit = Math.min(Math.max(Number(body?.limit) || 50, 1), 200);
        let q = supabase
          .from("session_summaries")
          .select(
            "id, patient_id, event_id, drive_file_id, drive_file_name, created_at",
          )
          .eq("therapist_id", therapistId)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (body?.patient_id) {
          if (!isUuid(body.patient_id))
            return json(400, { error: "Invalid 'patient_id'" });
          q = q.eq("patient_id", body.patient_id);
        }
        const { data, error } = await q;
        if (error) throw error;
        // Join names
        const { data: pats } = await supabase
          .from("patients")
          .select("id, name")
          .eq("therapist_id", therapistId);
        const nameById = new Map((pats || []).map((p: any) => [p.id, p.name]));
        return json(200, {
          sessions: (data || []).map((s: any) => ({
            ...s,
            patient_name: nameById.get(s.patient_id) || null,
          })),
        });
      }

      // ---------- DASHBOARD-MIRROR actions ----------
      case "get_monthly_summary": {
        const m = await buildBillingForMonth(supabase, therapistId, requestedMonth);
        const total_billed = m.billingByPatient.reduce((s, x) => s + x.total_billed, 0);
        const total_paid = m.billingByPatient.reduce((s, x) => s + x.total_paid, 0);
        const total_unpaid = total_billed - total_paid;
        const session_count = m.billingByPatient.reduce((s, x) => s + x.session_count, 0);
        const paid_session_count = m.billingByPatient.reduce(
          (s, x) => s + x.paid_session_count,
          0,
        );
        return json(200, {
          month: m.month,
          total_billed,
          total_paid,
          total_unpaid,
          session_count,
          paid_session_count,
          unpaid_session_count: session_count - paid_session_count,
          patient_count: m.billingByPatient.length,
          per_patient: m.billingByPatient.map((b) => ({
            patient_id: b.patient_id,
            patient_name: b.patient_name,
            session_count: b.session_count,
            total_billed: b.total_billed,
            total_paid: b.total_paid,
            total_unpaid: b.total_unpaid,
          })),
        });
      }

      case "get_unpaid_sessions": {
        const m = await buildBillingForMonth(supabase, therapistId, requestedMonth);
        const result = m.billingByPatient
          .filter((b) => b.unpaid_session_count > 0)
          .map((b) => ({
            patient_id: b.patient_id,
            patient_name: b.patient_name,
            unpaid_session_count: b.unpaid_session_count,
            total_unpaid: b.total_unpaid,
            sessions: b.unpaid_sessions,
          }))
          .sort((a, b) => b.total_unpaid - a.total_unpaid);
        const total_unpaid = result.reduce((s, x) => s + x.total_unpaid, 0);
        return json(200, { month: m.month, total_unpaid, patients: result });
      }

      case "get_todays_sessions": {
        // Today in Asia/Jerusalem -> day window in UTC
        const today = todayInJerusalem();
        const m = await buildBillingForMonth(
          supabase,
          therapistId,
          today.slice(0, 7),
        );
        // Filter sessions whose start date is today (Jerusalem)
        const fmtDay = (iso: string) =>
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Jerusalem",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(iso));
        const todays: any[] = [];
        for (const b of m.billingByPatient) {
          for (const s of b.sessions) {
            if (s.startISO && fmtDay(s.startISO) === today) {
              todays.push({
                patient_id: b.patient_id,
                patient_name: b.patient_name,
                event_id: s.eventId,
                start: s.startISO,
                summary: s.summary,
                price: s.sessionPrice,
              });
            }
          }
        }
        todays.sort((a, b) => a.start.localeCompare(b.start));
        return json(200, { date: today, sessions: todays });
      }

      case "get_sessions_without_summary": {
        const m = await buildBillingForMonth(supabase, therapistId, requestedMonth);
        const { data: sums } = await supabase
          .from("session_summaries")
          .select("event_id")
          .eq("therapist_id", therapistId);
        const summarized = new Set((sums || []).map((s: any) => s.event_id));
        const missing: any[] = [];
        for (const b of m.billingByPatient) {
          for (const s of b.sessions) {
            // Only past sessions (already happened)
            if (new Date(s.startISO).getTime() > Date.now()) continue;
            if (!summarized.has(s.eventId)) {
              missing.push({
                patient_id: b.patient_id,
                patient_name: b.patient_name,
                event_id: s.eventId,
                date: s.date,
                start: s.startISO,
                summary: s.summary,
              });
            }
          }
        }
        missing.sort((a, b) => a.start.localeCompare(b.start));
        return json(200, { month: m.month, count: missing.length, sessions: missing });
      }

      case "get_patient_details": {
        const patientId = body?.patient_id;
        if (!isUuid(patientId)) return json(400, { error: "Invalid 'patient_id'" });

        const m = await buildBillingForMonth(supabase, therapistId, requestedMonth);
        const patient = m.patientById.get(patientId);
        if (!patient)
          return json(404, { error: "Patient not found for this therapist" });
        const monthRow = m.billingByPatient.find((b) => b.patient_id === patientId);

        // All-time totals from payments table + manual debts (cheap, indicative)
        const allPayments = m.payments.filter((p) => p.patient_id === patientId);
        const allTimeBilled = allPayments.reduce(
          (s, r) => s + Number(r.amount || 0),
          0,
        );
        const allTimePaid = allPayments
          .filter((r) => r.paid)
          .reduce((s, r) => s + Number(r.amount || 0), 0);
        const manualDebt = m.debts
          .filter((d) => d.patient_id === patientId)
          .reduce((s, d) => s + Number(d.amount || 0), 0);

        return json(200, {
          patient: {
            id: patient.id,
            name: patient.name,
            phone: patient.phone,
            session_price: Number(patient.session_price),
            billing_type: patient.billing_type,
            mindme: !!patient.mindme,
          },
          this_month: monthRow
            ? {
                month: m.month,
                session_count: monthRow.session_count,
                total_billed: monthRow.total_billed,
                total_paid: monthRow.total_paid,
                total_unpaid: monthRow.total_unpaid,
                sessions: monthRow.sessions.map((s) => ({
                  event_id: s.eventId,
                  date: s.date,
                  price: s.sessionPrice,
                  paid: !monthRow.unpaid_sessions.find((u) => u.event_id === s.eventId),
                })),
              }
            : { month: m.month, session_count: 0 },
          all_time_payments_ledger: {
            note: "Aggregated from payments table; reflects billed/paid rows only.",
            total_billed: allTimeBilled,
            total_paid: allTimePaid,
            balance_owed: allTimeBilled - allTimePaid + manualDebt,
            manual_debt: manualDebt,
          },
        });
      }

      case "get_all_balances": {
        // Use this month's calendar-derived debts + manual_debts.
        const m = await buildBillingForMonth(supabase, therapistId, requestedMonth);
        const manualByPatient = new Map<string, number>();
        for (const d of m.debts) {
          manualByPatient.set(
            d.patient_id,
            (manualByPatient.get(d.patient_id) || 0) + Number(d.amount || 0),
          );
        }
        const rows = m.billingByPatient
          .map((b) => ({
            patient_id: b.patient_id,
            patient_name: b.patient_name,
            session_count: b.session_count,
            total_billed: b.total_billed,
            total_paid: b.total_paid,
            manual_debt: manualByPatient.get(b.patient_id) || 0,
            balance_owed:
              b.total_unpaid + (manualByPatient.get(b.patient_id) || 0),
          }))
          .filter((r) => r.balance_owed > 0)
          .sort((a, b) => b.balance_owed - a.balance_owed);
        const grand_total = rows.reduce((s, r) => s + r.balance_owed, 0);
        return json(200, { month: m.month, grand_total, patients: rows });
      }

      case "get_recent_activity": {
        const limit = Math.min(Math.max(Number(body?.limit) || 10, 1), 50);
        const [paysR, sumsR, patsR] = await Promise.all([
          supabase
            .from("payments")
            .select("id, patient_id, month, amount, paid, paid_at, updated_at")
            .eq("therapist_id", therapistId)
            .order("updated_at", { ascending: false })
            .limit(limit),
          supabase
            .from("session_summaries")
            .select("id, patient_id, event_id, created_at")
            .eq("therapist_id", therapistId)
            .order("created_at", { ascending: false })
            .limit(limit),
          supabase.from("patients").select("id, name").eq("therapist_id", therapistId),
        ]);
        if ((paysR as any).error) throw (paysR as any).error;
        if ((sumsR as any).error) throw (sumsR as any).error;
        const nameById = new Map(((patsR.data || []) as any[]).map((p) => [p.id, p.name]));
        const activity = [
          ...(paysR.data || []).map((p: any) => ({
            type: "payment",
            at: p.paid_at || p.updated_at,
            patient_id: p.patient_id,
            patient_name: nameById.get(p.patient_id) || null,
            month: p.month,
            amount: Number(p.amount || 0),
            paid: !!p.paid,
          })),
          ...(sumsR.data || []).map((s: any) => ({
            type: "session_summary",
            at: s.created_at,
            patient_id: s.patient_id,
            patient_name: nameById.get(s.patient_id) || null,
            event_id: s.event_id,
          })),
        ]
          .sort((a, b) => (b.at || "").localeCompare(a.at || ""))
          .slice(0, limit);
        return json(200, { activity });
      }

      // ---------- Write ----------
      case "add_session_summary": {
        const patientId = body?.patient_id;
        const eventId = body?.event_id;
        if (!isUuid(patientId)) return json(400, { error: "Invalid 'patient_id'" });
        if (typeof eventId !== "string" || !eventId.trim())
          return json(400, { error: "Missing 'event_id'" });
        const { data: patient, error: pErr } = await supabase
          .from("patients")
          .select("id")
          .eq("id", patientId)
          .eq("therapist_id", therapistId)
          .maybeSingle();
        if (pErr) throw pErr;
        if (!patient) return json(404, { error: "Patient not found for this therapist" });
        const trimmedEventId = eventId.trim();
        const calendarId =
          typeof body?.calendar_id === "string" && body.calendar_id.trim()
            ? body.calendar_id.trim()
            : "primary";
        const row = {
          therapist_id: therapistId,
          patient_id: patientId,
          event_id: trimmedEventId,
          drive_file_id:
            typeof body?.drive_file_id === "string" ? body.drive_file_id : null,
          drive_file_name:
            typeof body?.drive_file_name === "string" ? body.drive_file_name : null,
          updated_at: new Date().toISOString(),
        };
        const { data, error } = await supabase
          .from("session_summaries")
          .upsert(row, { onConflict: "therapist_id,event_id" })
          .select("id, patient_id, event_id, drive_file_id, drive_file_name, created_at")
          .single();
        if (error) throw error;

        // Best-effort: re-color the event in Google Calendar so it shows as
        // summarized in the dashboard / Sessions to Handle list.
        // Mirrors auto-color-events logic but runs inline (no JWT needed —
        // we already have the therapist's Google token via service role).
        let recolor: any = { attempted: false };
        try {
          recolor.attempted = true;
          const accessToken = await getFreshAccessToken(supabase, therapistId);

          // Pull current event to know colorId, start time, and skip cancelled.
          const evRes = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(trimmedEventId)}?fields=id,colorId,start`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (!evRes.ok) {
            recolor.error = `get event ${evRes.status}`;
          } else {
            const ev = await evRes.json();
            if (ev.colorId === CANCELLED_COLOR_ID) {
              recolor.skipped = "cancelled";
            } else {
              const startStr = ev.start?.dateTime || ev.start?.date;
              const startMs = startStr ? new Date(startStr).getTime() : NaN;
              const isPast = Number.isFinite(startMs) && startMs < Date.now();

              // Determine paid/invoiced for THIS event from payments table +
              // current calendar color (mirrors dashboard logic).
              const { data: payRows } = await supabase
                .from("payments")
                .select("paid_event_ids, external_payment_id")
                .eq("therapist_id", therapistId)
                .eq("paid", true);
              let paidInDb = false;
              let invoicedInDb = false;
              for (const p of payRows || []) {
                const ids = (p as any).paid_event_ids || [];
                if (ids.includes(trimmedEventId)) {
                  paidInDb = true;
                  if ((p as any).external_payment_id) invoicedInDb = true;
                }
              }
              const paidByColor = ev.colorId && PAID_COLORS.has(ev.colorId);
              const paid = paidInDb || !!paidByColor;
              const invoiced = invoicedInDb;

              // summarized=true (we just inserted), apply target color.
              let target: string | null = null;
              if (paid && invoiced) target = "3";
              else if (paid) target = "7";
              else target = "5"; // summarized + not paid

              if ((ev.colorId || null) !== target) {
                const patchRes = await fetch(
                  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(trimmedEventId)}?fields=id,colorId`,
                  {
                    method: "PATCH",
                    headers: {
                      Authorization: `Bearer ${accessToken}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ colorId: target }),
                  },
                );
                recolor.patched = patchRes.ok;
                recolor.colorId = target;
                if (!patchRes.ok) recolor.error = `patch ${patchRes.status}`;
              } else {
                recolor.skipped = "already-correct";
                recolor.colorId = target;
              }
            }
          }
        } catch (e) {
          recolor.error = e instanceof Error ? e.message : String(e);
        }

        return json(200, { session_summary: data, recolor });
      }

      default:
        return json(400, {
          error: `Unknown action '${action}'`,
          supported: [
            "describe_schema",
            "get_patients",
            "get_sessions",
            "get_monthly_summary",
            "get_unpaid_sessions",
            "get_todays_sessions",
            "get_sessions_without_summary",
            "get_patient_details",
            "get_all_balances",
            "get_recent_activity",
            "add_session_summary",
          ],
        });
    }
  } catch (e) {
    console.error("telegram-bridge error:", e);
    return json(500, { error: e instanceof Error ? e.message : "Unknown error" });
  }
});
