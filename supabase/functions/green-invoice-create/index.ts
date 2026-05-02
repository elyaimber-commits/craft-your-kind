import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GI_BASE = "https://api.greeninvoice.co.il/api/v1";

interface SessionLine {
  date: string;       // D/M/YY display
  price: number;      // amount per session
  description?: string;
  eventId?: string;
  calendarId?: string;
  startISO?: string;
  paid?: boolean;
}

interface RequestBody {
  patientId: string;
  documentType: 320 | 305 | 400; // 320=invoice/receipt, 305=invoice, 400=receipt
  // Either provide sessions OR a customAmount with a description
  sessions?: SessionLine[];
  customAmount?: number;
  customDescription?: string;
  // Optional override; otherwise we use Green Invoice's stored email for the client
  sendByEmail?: boolean;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ===== Auth =====
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace('Bearer ', '');
    const { data: claimsData, error: claimsErr } = await supabase.auth.getClaims(token);
    if (claimsErr || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const userId = claimsData.claims.sub;

    // ===== Parse body =====
    const body: RequestBody = await req.json();
    if (!body.patientId || !body.documentType) {
      return new Response(JSON.stringify({ error: 'patientId and documentType are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (![320, 305, 400].includes(body.documentType)) {
      return new Response(JSON.stringify({ error: 'documentType must be 320, 305 or 400' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const hasSessions = Array.isArray(body.sessions) && body.sessions.length > 0;
    const hasCustom = typeof body.customAmount === 'number' && body.customAmount > 0;
    if (!hasSessions && !hasCustom) {
      return new Response(JSON.stringify({ error: 'Provide sessions or customAmount' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ===== Load patient (RLS will scope to this therapist) =====
    const { data: patient, error: patientErr } = await supabase
      .from('patients')
      .select('id, name, phone, green_invoice_customer_id, therapist_id')
      .eq('id', body.patientId)
      .single();

    if (patientErr || !patient) {
      return new Response(JSON.stringify({ error: 'Patient not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (patient.therapist_id !== userId) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!patient.green_invoice_customer_id) {
      return new Response(JSON.stringify({
        error: 'למטופל אין מזהה לקוח ב-Green Invoice. הוסף אותו בכרטיס המטופל לפני הפקת חשבונית.'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ===== Authenticate with Green Invoice =====
    const apiKeyId = Deno.env.get('GREEN_INVOICE_API_KEY_ID');
    const apiKeySecret = Deno.env.get('GREEN_INVOICE_API_KEY_SECRET');
    if (!apiKeyId || !apiKeySecret) {
      return new Response(JSON.stringify({ error: 'Green Invoice API keys not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Authenticating with Green Invoice...');
    const tokenRes = await fetch(`${GI_BASE}/account/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: apiKeyId, secret: apiKeySecret }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('GI auth failed:', errText);
      return new Response(JSON.stringify({ error: 'Green Invoice authentication failed', details: errText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const tokenJson = await tokenRes.json();
    const giToken = tokenJson.token;

    // ===== Fetch client details from Green Invoice (for email + name) =====
    let clientEmail: string | undefined;
    let clientName = patient.name;

    const clientRes = await fetch(`${GI_BASE}/clients/${patient.green_invoice_customer_id}`, {
      headers: { 'Authorization': `Bearer ${giToken}` },
    });

    if (clientRes.ok) {
      const clientData = await clientRes.json();
      clientEmail = clientData.emails?.[0] || clientData.email;
      clientName = clientData.name || patient.name;
      console.log('Client email from GI:', clientEmail || '(none)');
    } else {
      console.warn('Failed to fetch client from GI:', clientRes.status);
    }

    // ===== Build income lines =====
    // Green Invoice items: { description, quantity, price, currency, vatType }
    // vatType: 1 = VAT included (default for Israeli invoices)
    const income = hasSessions
      ? body.sessions!.map((s) => ({
          description: s.description || `פגישה ${s.date}`,
          quantity: 1,
          price: Number(s.price),
          currency: 'ILS',
          vatType: 1,
        }))
      : [{
          description: body.customDescription || 'שירותי טיפול',
          quantity: 1,
          price: Number(body.customAmount),
          currency: 'ILS',
          vatType: 1,
        }];

    const totalAmount = income.reduce((sum, i) => sum + i.price * i.quantity, 0);

    // ===== Build document =====
    // Document types: 320 = חשבונית מס/קבלה, 305 = חשבונית מס, 400 = קבלה
    const sendEmail = body.sendByEmail !== false && !!clientEmail;

    const docPayload: any = {
      type: body.documentType,
      lang: 'he',
      currency: 'ILS',
      vatType: 1, // VAT included
      client: {
        id: patient.green_invoice_customer_id,
        name: clientName,
        ...(clientEmail ? { emails: [clientEmail] } : {}),
      },
      income,
      // For receipts (320, 400), include payment info
      ...(body.documentType !== 305 ? {
        payment: [{
          date: new Date().toISOString().split('T')[0],
          type: 3, // 3 = העברה בנקאית; user can change in GI later. 1=מזומן, 2=המחאה, 3=העברה, 4=כרטיס אשראי
          price: totalAmount,
          currency: 'ILS',
        }],
      } : {}),
      // Auto-send by email if we have a client email
      ...(sendEmail ? {
        emailContent: 'מצורפת חשבונית עבור שירותי טיפול. תודה!',
        sendEmail: true,
      } : {}),
    };

    console.log('Creating GI document:', JSON.stringify(docPayload));

    const docRes = await fetch(`${GI_BASE}/documents`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${giToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(docPayload),
    });

    const docResult = await docRes.json();

    if (!docRes.ok) {
      console.error('GI document creation failed:', JSON.stringify(docResult));
      return new Response(JSON.stringify({
        error: 'יצירת חשבונית ב-Green Invoice נכשלה',
        details: docResult,
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('GI document created:', docResult.id, docResult.number);

    // Persist invoice/receipt status for selected calendar sessions and recolor them.
    if (hasSessions) {
      const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const byMonth = new Map<string, SessionLine[]>();
      for (const s of body.sessions!.filter((s) => s.eventId)) {
        const d = s.startISO ? new Date(s.startISO) : new Date();
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit' }).formatToParts(d);
        const monthKey = `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
        byMonth.set(monthKey, [...(byMonth.get(monthKey) || []), s]);
      }

      for (const [monthKey, items] of byMonth.entries()) {
        const eventIds = items.map((s) => s.eventId!).filter(Boolean);
        const paidEventIds = body.documentType === 305
          ? items.filter((s) => s.paid).map((s) => s.eventId!).filter(Boolean)
          : eventIds;
        const amountForMonth = items.reduce((sum, s) => sum + Number(s.price || 0), 0);

        const { data: existing } = await service
          .from('payments')
          .select('id, paid_event_ids, amount')
          .eq('patient_id', patient.id)
          .eq('month', monthKey)
          .maybeSingle();

        if (existing) {
          const mergedIds = Array.from(new Set([...(existing.paid_event_ids || []), ...paidEventIds]));
          await service.from('payments').update({
            paid_event_ids: mergedIds,
            session_count: mergedIds.length,
            paid: mergedIds.length > 0,
            paid_at: mergedIds.length > 0 ? new Date().toISOString() : null,
            amount: Math.max(Number(existing.amount || 0), amountForMonth),
            receipt_number: docResult.number ? String(docResult.number) : null,
            external_source: 'green_invoice',
            external_payment_id: String(docResult.id || docResult.number),
            status: 'paid',
          }).eq('id', existing.id);
        } else {
          await service.from('payments').insert({
            therapist_id: userId,
            patient_id: patient.id,
            month: monthKey,
            amount: amountForMonth,
            session_count: paidEventIds.length,
            paid_event_ids: paidEventIds,
            paid: paidEventIds.length > 0,
            paid_at: paidEventIds.length > 0 ? new Date().toISOString() : null,
            receipt_number: docResult.number ? String(docResult.number) : null,
            external_source: 'green_invoice',
            external_payment_id: String(docResult.id || docResult.number),
            status: 'paid',
          });
        }
      }

      const colorEvents = body.sessions!
        .filter((s) => s.eventId && s.calendarId)
        .map((s) => ({ eventId: s.eventId!, calendarId: s.calendarId! }));
      if (colorEvents.length > 0) {
        fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/auto-color-events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body: JSON.stringify({ events: colorEvents }),
        }).catch((e) => console.error('auto-color trigger failed:', e));
      }
    }

    return new Response(JSON.stringify({
      success: true,
      documentId: docResult.id,
      documentNumber: docResult.number,
      documentUrl: docResult.url?.he || docResult.url?.origin,
      sentByEmail: sendEmail,
      recipientEmail: sendEmail ? clientEmail : null,
      amount: totalAmount,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('green-invoice-create error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
