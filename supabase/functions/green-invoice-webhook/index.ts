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
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
    const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Green Invoice sends a POST with document data
    const payload = await req.json();
    console.log("Green Invoice webhook received:", JSON.stringify(payload));

    // Extract client ID from the webhook payload
    // Green Invoice document structure has client.id
    const clientId = payload?.recipient?.id || payload?.client?.id;
    if (!clientId) {
      console.log("No client ID in webhook payload, ignoring");
      return new Response(JSON.stringify({ ok: true, message: "No client ID, ignored" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Document types that indicate payment: 
    // 320 = receipt, 305 = invoice+receipt, 400 = receipt
    const paymentDocTypes = [320, 305, 400];
    const docType = payload?.type;
    if (docType && !paymentDocTypes.includes(docType)) {
      console.log(`Document type ${docType} is not a payment document, ignoring`);
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
      return new Response(JSON.stringify({ ok: true, message: "No matching patient found" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Found patient: ${patient.name} (${patient.id})`);

    // Parse month from document description/remarks (e.g. "יעל ונר ינואר")
    // or fall back to document date
    const hebrewMonths: Record<string, number> = {
      'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'אפריל': 4,
      'מאי': 5, 'יוני': 6, 'יולי': 7, 'אוגוסט': 8,
      'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12,
    };

    let month = '';
    const description = payload?.description || payload?.remarks || payload?.comment || '';
    console.log(`Document description: "${description}"`);

    // Try to find a Hebrew month name in the description
    for (const [monthName, monthNum] of Object.entries(hebrewMonths)) {
      if (description.includes(monthName)) {
        // Determine the year: if the month is in the future relative to now, use previous year
        const now = new Date();
        let year = now.getFullYear();
        if (monthNum > now.getMonth() + 1) {
          year--; // e.g., mentioning "דצמבר" in January means last year's December
        }
        month = `${year}-${String(monthNum).padStart(2, '0')}`;
        console.log(`Parsed month from description: ${monthName} → ${month}`);
        break;
      }
    }

    // Fallback to document date if no month found in description
    if (!month) {
      const docDate = payload?.documentDate || payload?.createdAt || new Date().toISOString();
      const date = new Date(docDate);
      month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      console.log(`Using document date for month: ${month}`);
    }

    // Check if this patient is an institution (parent) - if so, also mark children as paid
    const { data: patientFull } = await supabase
      .from('patients')
      .select('billing_type')
      .eq('id', patient.id)
      .single();

    const isInstitution = patientFull?.billing_type === 'institution';

    // Get child patients if institution
    let childPatientIds: string[] = [];
    if (isInstitution) {
      const { data: children } = await supabase
        .from('patients')
        .select('id, name')
        .eq('parent_patient_id', patient.id);
      childPatientIds = (children || []).map((c: any) => c.id);
      console.log(`Institution ${patient.name} has ${childPatientIds.length} children: ${(children || []).map((c: any) => c.name).join(', ')}`);
    }

    // All patient IDs to mark as paid (parent + children for institutions)
    const allPatientIds = [patient.id, ...childPatientIds];

    for (const pid of allPatientIds) {
      // Check if payment record exists for this patient+month
      const { data: existingPayment } = await supabase
        .from('payments')
        .select('id')
        .eq('patient_id', pid)
        .eq('month', month)
        .single();

      if (existingPayment) {
        await supabase
          .from('payments')
          .update({
            paid: true,
            paid_at: new Date().toISOString(),
            amount: pid === patient.id && amount > 0 ? amount : undefined,
            receipt_number: pid === patient.id ? receiptNumber : undefined,
          })
          .eq('id', existingPayment.id);
      } else {
        await supabase
          .from('payments')
          .insert({
            therapist_id: patient.therapist_id,
            patient_id: pid,
            month,
            amount: pid === patient.id && amount > 0 ? amount : 0,
            session_count: 0,
            paid: true,
            paid_at: new Date().toISOString(),
            receipt_number: pid === patient.id ? receiptNumber : null,
          });
      }
    }

    console.log(`Payment marked as paid for ${patient.name}${isInstitution ? ` + ${childPatientIds.length} children` : ''}, month ${month}`);

    // Now update Google Calendar event colors to purple (paid)
    // Get the therapist's Google tokens
    const { data: tokenData } = await supabase
      .from('google_tokens')
      .select('*')
      .eq('user_id', patient.therapist_id)
      .single();

    if (tokenData) {
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

      if (accessToken) {
        // Find yellow events matching this patient's name in the target month
        const [yearStr, monthStr] = month.split('-');
        const monthYear = parseInt(yearStr);
        const monthIdx = parseInt(monthStr) - 1;
        const startOfMonth = new Date(monthYear, monthIdx, 1).toISOString();
        const endOfMonth = new Date(monthYear, monthIdx + 1, 0, 23, 59, 59).toISOString();

        // Get all calendars
        const calListRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const calListData = await calListRes.json();
        const calendars = calListData.items || [];

        const patientNameLower = patient.name.trim().toLowerCase();
        let colorUpdated = 0;

        // Get aliases for this patient (and children if institution) to match calendar events
        const aliasPatientIds = [patient.id, ...childPatientIds];
        const { data: aliasData } = await supabase
          .from('event_aliases')
          .select('event_name')
          .in('patient_id', aliasPatientIds);
        
        const aliasNames = new Set<string>([patientNameLower]);
        if (aliasData) {
          for (const a of aliasData) {
            aliasNames.add(a.event_name.trim().toLowerCase());
          }
        }

        // Also add child patient names
        if (isInstitution) {
          const { data: childPatients } = await supabase
            .from('patients')
            .select('name')
            .in('id', childPatientIds);
          if (childPatients) {
            for (const c of childPatients) {
              aliasNames.add(c.name.trim().toLowerCase());
            }
          }
        }

        console.log(`Matching names for ${patient.name}:`, [...aliasNames]);

        for (const cal of calendars) {
          const eventsRes = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` +
            `timeMin=${encodeURIComponent(startOfMonth)}&timeMax=${encodeURIComponent(endOfMonth)}&singleEvents=true&maxResults=250`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const eventsData = await eventsRes.json();
          const events = eventsData.items || [];

          // Find yellow events (colorId "5") matching patient name OR any alias
          const matchingEvents = events.filter((e: any) =>
            e.colorId === "5" && aliasNames.has((e.summary || "").trim().toLowerCase())
          );

          for (const event of matchingEvents) {
            const patchRes = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(event.id)}`,
              {
                method: 'PATCH',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ colorId: "3" }), // Purple = paid
              }
            );
            if (patchRes.ok) colorUpdated++;
          }
        }

        console.log(`Updated ${colorUpdated} calendar events to purple for ${patient.name}`);
      }
    }

    return new Response(JSON.stringify({ ok: true, message: "Payment processed" }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Webhook error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});