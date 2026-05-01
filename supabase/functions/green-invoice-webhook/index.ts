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

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Helper to log webhook calls
  const logWebhook = async (data: {
    status_code: number;
    event_type?: string | null;
    external_payment_id?: string | null;
    matched_patient_id?: string | null;
    therapist_id?: string | null;
    error?: string | null;
    payload?: unknown;
  }) => {
    try {
      await supabase.from('webhook_logs').insert({
        source: 'green_invoice',
        status_code: data.status_code,
        event_type: data.event_type ?? null,
        external_payment_id: data.external_payment_id ?? null,
        matched_patient_id: data.matched_patient_id ?? null,
        therapist_id: data.therapist_id ?? null,
        error: data.error ?? null,
        payload: data.payload ?? null,
      });
    } catch (e) {
      console.error('Failed to write webhook_logs:', e);
    }
  };

  // Read body as text first to handle empty bodies (ping/handshake) gracefully
  const rawBody = await req.text();
  console.log(`Green Invoice webhook received. method=${req.method}, body length=${rawBody.length}`);

  // Empty body = ping / health check from Morning. Respond OK.
  if (!rawBody || rawBody.trim() === '') {
    await logWebhook({ status_code: 200, event_type: 'ping', payload: null });
    return new Response(JSON.stringify({ ok: true, ping: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid json';
    console.error('Invalid JSON body:', msg, 'raw:', rawBody.slice(0, 500));
    await logWebhook({ status_code: 400, error: `invalid_json: ${msg}`, payload: rawBody.slice(0, 1000) });
    // Return 200 to Morning to avoid disabling the webhook, but log the error
    return new Response(JSON.stringify({ ok: false, error: 'invalid_json' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  console.log("Green Invoice webhook payload:", JSON.stringify(payload));

  try {
    const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
    const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

    const docType = payload?.type;
    const externalIdEarly = payload?.id ? String(payload.id) : (payload?.number ? String(payload.number) : null);

    // Extract client ID from the webhook payload
    const clientId = payload?.recipient?.id || payload?.client?.id;
    if (!clientId) {
      console.log("No client ID in webhook payload, ignoring");
      await logWebhook({ status_code: 200, event_type: docType ? String(docType) : 'unknown', external_payment_id: externalIdEarly, error: 'no_client_id', payload });
      return new Response(JSON.stringify({ ok: true, message: "No client ID, ignored" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Document types that indicate payment: 
    // 320 = receipt, 305 = invoice+receipt, 400 = receipt
    const paymentDocTypes = [320, 305, 400];
    if (docType && !paymentDocTypes.includes(docType)) {
      console.log(`Document type ${docType} is not a payment document, ignoring`);
      await logWebhook({ status_code: 200, event_type: String(docType), external_payment_id: externalIdEarly, error: 'not_payment_doc', payload });
      return new Response(JSON.stringify({ ok: true, message: "Not a payment document" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Find the patient by green_invoice_customer_id
    const { data: patient, error: patientError } = await supabase
      .from('patients')
      .select('id, name, therapist_id, session_price')
      .eq('green_invoice_customer_id', clientId)
      .single();

    if (patientError || !patient) {
      console.log(`No patient found for Green Invoice client ID: ${clientId}`);
      await logWebhook({ status_code: 200, event_type: docType ? String(docType) : null, external_payment_id: externalIdEarly, error: `no_patient_for_client_id:${clientId}`, payload });
      return new Response(JSON.stringify({ ok: true, message: "No matching patient found" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Found patient: ${patient.name} (${patient.id})`);

    // Extract amount and receipt number from payload
    const amount = Number(payload?.total) || 0;
    const receiptNumber = payload?.number ? String(payload.number) : null;
    const externalPaymentId = String(payload?.id || payload?.number || `${clientId}-${Date.now()}`);
    console.log(`Payment amount: ${amount}, receipt number: ${receiptNumber}, external_payment_id: ${externalPaymentId}`);

    // Check if this patient is an institution (parent) - if so, also include children
    const { data: patientFull } = await supabase
      .from('patients')
      .select('billing_type, session_price')
      .eq('id', patient.id)
      .single();

    const isInstitution = patientFull?.billing_type === 'institution';
    const sessionPrice = Number(patient.session_price) || Number(patientFull?.session_price) || 0;

    // Get child patients if institution
    let childPatientIds: string[] = [];
    if (isInstitution) {
      const { data: children } = await supabase
        .from('patients')
        .select('id, name')
        .eq('parent_patient_id', patient.id);
      childPatientIds = (children || []).map((c: any) => c.id);
      console.log(`Institution ${patient.name} has ${childPatientIds.length} children`);
    }

    const allPatientIds = [patient.id, ...childPatientIds];

    // Calculate how many sessions this payment covers
    if (sessionPrice <= 0) {
      console.error(`Cannot calculate sessions: session_price is ${sessionPrice}`);
      await logWebhook({ status_code: 200, event_type: docType ? String(docType) : null, external_payment_id: externalPaymentId, matched_patient_id: patient.id, therapist_id: patient.therapist_id, error: 'no_session_price', payload });
      return new Response(JSON.stringify({ ok: true, message: "No session price set" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Use the document subtotal (excl. VAT) when available, since session_price is also stored excl. VAT.
    // Fall back to total if subtotal is missing.
    const baseForCount = Number(payload?.subtotal) || Number(payload?.taxableTotal) || amount;
    const sessionsCovered = Math.round(baseForCount / sessionPrice);
    console.log(`Payment covers ${sessionsCovered} sessions (base ${baseForCount} / price ${sessionPrice})`);

    if (sessionsCovered <= 0) {
      await logWebhook({ status_code: 200, event_type: docType ? String(docType) : null, external_payment_id: externalPaymentId, matched_patient_id: patient.id, therapist_id: patient.therapist_id, error: 'zero_sessions_covered', payload });
      return new Response(JSON.stringify({ ok: true, message: "Zero sessions covered" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get Google tokens
    const { data: tokenData } = await supabase
      .from('google_tokens')
      .select('*')
      .eq('user_id', patient.therapist_id)
      .single();

    if (!tokenData) {
      console.error('No Google tokens for therapist');
      await logWebhook({ status_code: 200, event_type: docType ? String(docType) : null, external_payment_id: externalPaymentId, matched_patient_id: patient.id, therapist_id: patient.therapist_id, error: 'no_google_tokens', payload });
      return new Response(JSON.stringify({ ok: true, message: "No Google tokens" }), {
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
      if (refreshRes.ok) {
        accessToken = refreshData.access_token;
        const newExpiresAt = new Date(Date.now() + (refreshData.expires_in || 3600) * 1000).toISOString();
        await supabase
          .from('google_tokens')
          .update({ access_token: accessToken, expires_at: newExpiresAt })
          .eq('user_id', patient.therapist_id);
      } else {
        console.error("Failed to refresh Google token:", refreshData);
      }
    }

    // Build alias name set (patient + children + aliases)
    const aliasNames = new Set<string>([patient.name.trim().toLowerCase()]);
    const { data: aliasData } = await supabase
      .from('event_aliases')
      .select('event_name, patient_id')
      .in('patient_id', allPatientIds);
    const aliasToPatient = new Map<string, string>();
    aliasToPatient.set(patient.name.trim().toLowerCase(), patient.id);
    if (aliasData) {
      for (const a of aliasData) {
        const key = a.event_name.trim().toLowerCase();
        aliasNames.add(key);
        aliasToPatient.set(key, a.patient_id);
      }
    }
    if (isInstitution) {
      const { data: childPatients } = await supabase
        .from('patients')
        .select('id, name')
        .in('id', childPatientIds);
      if (childPatients) {
        for (const c of childPatients) {
          const key = c.name.trim().toLowerCase();
          aliasNames.add(key);
          aliasToPatient.set(key, c.id);
        }
      }
    }
    console.log(`Matching names for ${patient.name}:`, [...aliasNames]);

    // Time window: scan from 12 months ago up to today (oldest first)
    const now = new Date();
    const timeMin = new Date(now.getFullYear(), now.getMonth() - 12, 1).toISOString();
    const timeMax = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

    // Fetch existing paid_event_ids across all months for these patients (to skip already-paid ones)
    const { data: existingPaidPayments } = await supabase
      .from('payments')
      .select('paid_event_ids')
      .in('patient_id', allPatientIds);
    const alreadyPaidEventIds = new Set<string>();
    if (existingPaidPayments) {
      for (const p of existingPaidPayments) {
        for (const id of (p.paid_event_ids || []) as string[]) {
          alreadyPaidEventIds.add(id);
        }
      }
    }

    // Get ignored events
    const { data: ignoredData } = await supabase
      .from('ignored_calendar_events')
      .select('event_name')
      .eq('therapist_id', patient.therapist_id);
    const ignoredNames = new Set<string>((ignoredData || []).map((i: any) => i.event_name.trim().toLowerCase()));

    // Get all calendars
    const calListRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const calListData = await calListRes.json();
    const calendars = calListData.items || [];

    // Collect all matching events across calendars
    type CandidateEvent = {
      calendarId: string;
      eventId: string;
      summary: string;
      startISO: string;
      colorId?: string;
      patientId: string;
    };
    const candidates: CandidateEvent[] = [];

    for (const cal of calendars) {
      const eventsRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` +
        `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&maxResults=2500&orderBy=startTime`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const eventsData = await eventsRes.json();
      const events = eventsData.items || [];

      for (const e of events) {
        const summary = (e.summary || "").trim();
        const summaryLower = summary.toLowerCase();
        if (!aliasNames.has(summaryLower)) continue;
        if (ignoredNames.has(summaryLower)) continue;
        // Skip already-paid (purple=3) and cancelled (flamingo=4)
        if (e.colorId === "3" || e.colorId === "4") continue;
        // Skip if event is in alreadyPaidEventIds
        if (alreadyPaidEventIds.has(e.id)) continue;
        const startISO = e.start?.dateTime || e.start?.date;
        if (!startISO) continue;
        // Only past events (don't sweep future ones)
        if (new Date(startISO) > now) continue;

        const pid = aliasToPatient.get(summaryLower) || patient.id;
        candidates.push({
          calendarId: cal.id,
          eventId: e.id,
          summary,
          startISO,
          colorId: e.colorId,
          patientId: pid,
        });
      }
    }

    // Sort oldest first
    candidates.sort((a, b) => a.startISO.localeCompare(b.startISO));
    console.log(`Found ${candidates.length} unpaid past events; will mark ${Math.min(sessionsCovered, candidates.length)}`);

    // Take the oldest N sessions
    const toMark = candidates.slice(0, sessionsCovered);

    // Group by month (Asia/Jerusalem) → patient → event ids
    const monthFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem',
      year: 'numeric',
      month: '2-digit',
    });
    const grouped = new Map<string, Map<string, string[]>>(); // month -> pid -> [eventIds]
    for (const ev of toMark) {
      const parts = monthFmt.formatToParts(new Date(ev.startISO));
      const y = parts.find(p => p.type === 'year')?.value || '0000';
      const m = parts.find(p => p.type === 'month')?.value || '00';
      const monthKey = `${y}-${m}`;
      if (!grouped.has(monthKey)) grouped.set(monthKey, new Map());
      const pidMap = grouped.get(monthKey)!;
      if (!pidMap.has(ev.patientId)) pidMap.set(ev.patientId, []);
      pidMap.get(ev.patientId)!.push(ev.eventId);
    }

    // Patch calendar events to purple
    let colorUpdated = 0;
    for (const ev of toMark) {
      const patchRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ev.calendarId)}/events/${encodeURIComponent(ev.eventId)}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ colorId: "3" }),
        }
      );
      if (patchRes.ok) colorUpdated++;
      else console.error(`Failed to patch event ${ev.eventId}:`, await patchRes.text());
    }
    console.log(`Updated ${colorUpdated} calendar events to purple`);

    // Update payment records per month
    // The payment record holding the receipt/external_payment_id goes on the LATEST month touched
    // (or the document month if no events were matched).
    const sortedMonths = [...grouped.keys()].sort();
    const receiptMonth = sortedMonths.length > 0
      ? sortedMonths[sortedMonths.length - 1]
      : (() => {
          const docDate = payload?.documentDate || payload?.createdAt || new Date().toISOString();
          const d = new Date(docDate);
          const parts = monthFmt.formatToParts(d);
          const y = parts.find(p => p.type === 'year')?.value || '0000';
          const m = parts.find(p => p.type === 'month')?.value || '00';
          return `${y}-${m}`;
        })();

    for (const [monthKey, pidMap] of grouped.entries()) {
      for (const [pid, eventIds] of pidMap.entries()) {
        const isParent = pid === patient.id;
        const isReceiptMonth = monthKey === receiptMonth;

        const { data: existingPayment } = await supabase
          .from('payments')
          .select('id, paid_event_ids, amount')
          .eq('patient_id', pid)
          .eq('month', monthKey)
          .maybeSingle();

        if (existingPayment) {
          const mergedIds = new Set<string>([...((existingPayment.paid_event_ids || []) as string[]), ...eventIds]);
          const updateData: Record<string, unknown> = {
            paid_event_ids: Array.from(mergedIds),
            session_count: mergedIds.size,
            paid: true,
            paid_at: new Date().toISOString(),
            status: 'paid',
          };
          if (isParent && isReceiptMonth) {
            if (amount > 0) updateData.amount = amount;
            updateData.receipt_number = receiptNumber;
            updateData.external_source = 'green_invoice';
            updateData.external_payment_id = externalPaymentId;
          }
          const { error: updErr } = await supabase
            .from('payments')
            .update(updateData)
            .eq('id', existingPayment.id);
          if (updErr) console.error(`Update payment error for ${pid}/${monthKey}:`, updErr);
        } else {
          const insertData: Record<string, unknown> = {
            therapist_id: patient.therapist_id,
            patient_id: pid,
            month: monthKey,
            amount: isParent && isReceiptMonth && amount > 0 ? amount : 0,
            session_count: eventIds.length,
            paid_event_ids: eventIds,
            paid: true,
            paid_at: new Date().toISOString(),
            status: 'paid',
            receipt_number: isParent && isReceiptMonth ? receiptNumber : null,
          };
          if (isParent && isReceiptMonth) {
            insertData.external_source = 'green_invoice';
            insertData.external_payment_id = externalPaymentId;
          }
          const { error: insErr } = await supabase
            .from('payments')
            .insert(insertData);
          if (insErr) console.error(`Insert payment error for ${pid}/${monthKey}:`, insErr);
        }
        console.log(`Updated payment for patient ${pid} month ${monthKey} with ${eventIds.length} event IDs${isParent && isReceiptMonth ? ' (receipt month)' : ''}`);
      }
    }

    // If no events were matched, still record the payment on the document month so it's not lost
    if (sortedMonths.length === 0) {
      const isParent = true;
      const { data: existingPayment } = await supabase
        .from('payments')
        .select('id')
        .eq('patient_id', patient.id)
        .eq('month', receiptMonth)
        .maybeSingle();
      const baseData: Record<string, unknown> = {
        amount,
        receipt_number: receiptNumber,
        external_source: 'green_invoice',
        external_payment_id: externalPaymentId,
        paid: true,
        paid_at: new Date().toISOString(),
        status: 'paid',
      };
      if (existingPayment) {
        await supabase.from('payments').update(baseData).eq('id', existingPayment.id);
      } else {
        await supabase.from('payments').insert({
          therapist_id: patient.therapist_id,
          patient_id: patient.id,
          month: receiptMonth,
          session_count: 0,
          ...baseData,
        });
      }
      console.log(`No matching events; recorded payment on ${receiptMonth} only`);
    }

    await logWebhook({
      status_code: 200,
      event_type: docType ? String(docType) : null,
      external_payment_id: externalPaymentId,
      matched_patient_id: patient.id,
      therapist_id: patient.therapist_id,
      payload,
    });

    return new Response(JSON.stringify({ ok: true, message: "Payment processed" }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Webhook error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    await logWebhook({
      status_code: 500,
      event_type: payload?.type ? String(payload.type) : null,
      external_payment_id: payload?.id ? String(payload.id) : null,
      error: message,
      payload,
    });
    // Return 200 so Morning doesn't disable the webhook; we logged the error
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});