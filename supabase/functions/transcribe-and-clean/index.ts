import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CLEAN_SYSTEM_PROMPT = `קבל תמלול גולמי בעברית של סיכום מטפל.
הפוך אותו לטקסט קריא בלבד.
אל תוסיף מידע.
אל תפרש או תנתח.
אל תשנה משמעות.
תקן רק שגיאות לשון ותמלול ברורות.
הסר חזרות ומילות מילוי.
שמור על ניסוח קרוב למקור.
אם לא ברור — השאר כפי שהוא.
חלק לפסקאות קצרות.
החזר רק טקסט נקי.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ---- Auth ----
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: claimsData, error: claimsErr } = await supabase.auth.getClaims(token);
    if (claimsErr || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- Read audio ----
    const inForm = await req.formData();
    const audio = inForm.get("audio");
    if (!(audio instanceof File) && !(audio instanceof Blob)) {
      return new Response(JSON.stringify({ error: "Missing audio file" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const filename = (audio as File).name || "audio.webm";
    const size = (audio as Blob).size;
    if (size === 0) {
      return new Response(JSON.stringify({ error: "Empty audio" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (size > 25 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: "Audio file too large (max 25MB)" }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- 1. Transcription ----
    const transcribeForm = new FormData();
    transcribeForm.append("file", audio as Blob, filename);
    transcribeForm.append("model", "gpt-4o-mini-transcribe");
    transcribeForm.append("language", "he");
    transcribeForm.append("response_format", "json");

    const trResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: transcribeForm,
    });

    if (!trResp.ok) {
      const txt = await trResp.text();
      console.error("OpenAI transcription error:", trResp.status, txt);
      return new Response(JSON.stringify({ error: `Transcription failed: ${trResp.status}`, detail: txt }), {
        status: trResp.status === 429 ? 429 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const trJson = await trResp.json();
    const raw = (trJson.text || "").trim();

    if (!raw) {
      return new Response(JSON.stringify({ raw: "", cleaned: "" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- 2. Clean ----
    const cleanResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: CLEAN_SYSTEM_PROMPT },
          { role: "user", content: raw },
        ],
      }),
    });

    if (!cleanResp.ok) {
      const txt = await cleanResp.text();
      console.error("OpenAI cleaning error:", cleanResp.status, txt);
      // Fall back to raw if cleaning fails
      return new Response(JSON.stringify({ raw, cleaned: raw, warning: "cleaning_failed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const cleanJson = await cleanResp.json();
    const cleaned = (cleanJson.choices?.[0]?.message?.content || raw).trim();

    return new Response(JSON.stringify({ raw, cleaned }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("transcribe-and-clean error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
