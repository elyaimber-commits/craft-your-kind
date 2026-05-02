// Telegram bridge: read/write data from a simple HTTP endpoint.
// Auth: header "x-api-key" must equal TELEGRAM_BRIDGE_SECRET.
//
// Request body:
//   {
//     "action": "get_patients" | "get_sessions" | "add_session",
//     "therapist_id": "uuid",      // required, identifies the data owner
//     // for get_sessions (optional):
//     "patient_id": "uuid",
//     "limit": 50,
//     // for add_session:
//     "patient_id": "uuid",         // required
//     "event_id": "string",         // required
//     "drive_file_id": "string",    // optional
//     "drive_file_name": "string"   // optional
//   }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  // Auth
  const apiKey = req.headers.get("x-api-key");
  const expected = Deno.env.get("TELEGRAM_BRIDGE_SECRET");
  if (!expected) return json(500, { error: "Server not configured" });
  if (!apiKey || apiKey !== expected) {
    return json(401, { error: "Unauthorized" });
  }

  // Parse body
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

      case "get_sessions": {
        const limitRaw = Number(body?.limit);
        const limit = Number.isFinite(limitRaw)
          ? Math.min(Math.max(Math.floor(limitRaw), 1), 200)
          : 50;
        let q = supabase
          .from("session_summaries")
          .select(
            "id, patient_id, event_id, drive_file_id, drive_file_name, created_at, updated_at",
          )
          .eq("therapist_id", therapistId)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (body?.patient_id) {
          if (!isUuid(body.patient_id)) {
            return json(400, { error: "Invalid 'patient_id' (uuid)" });
          }
          q = q.eq("patient_id", body.patient_id);
        }
        const { data, error } = await q;
        if (error) throw error;
        return json(200, { sessions: data ?? [] });
      }

      case "add_session": {
        const patientId = body?.patient_id;
        const eventId = body?.event_id;
        if (!isUuid(patientId)) {
          return json(400, { error: "Missing or invalid 'patient_id' (uuid)" });
        }
        if (typeof eventId !== "string" || !eventId.trim()) {
          return json(400, { error: "Missing 'event_id' (string)" });
        }

        // Verify patient belongs to therapist
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
        return json(200, { session: data });
      }

      default:
        return json(400, {
          error: `Unknown action '${action}'. Supported: get_patients, get_sessions, add_session`,
        });
    }
  } catch (e) {
    console.error("telegram-bridge error:", e);
    return json(500, {
      error: e instanceof Error ? e.message : "Unknown error",
    });
  }
});
