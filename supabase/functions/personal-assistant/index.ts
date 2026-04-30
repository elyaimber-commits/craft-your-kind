import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface CalendarEvent {
  id: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  colorId?: string;
}

const BILLING_COLOR_IDS = ["5", "3"];
const isBillingEvent = (colorId?: string) => !colorId || BILLING_COLOR_IDS.includes(colorId);

function findGaps(events: CalendarEvent[], rangeStart: Date, rangeEnd: Date, minMinutes = 60) {
  // Filter and sort billing events with dateTime
  const sessions = events
    .filter((e) => isBillingEvent(e.colorId) && e.start.dateTime && e.end.dateTime)
    .map((e) => ({
      start: new Date(e.start.dateTime!),
      end: new Date(e.end.dateTime!),
    }))
    .filter((s) => s.end > rangeStart && s.start < rangeEnd)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const gaps: { start: Date; end: Date; minutes: number; dayOfWeek: number }[] = [];
  // Working hours: 8:00 - 21:00 Israel time, by day
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / dayMs);

  for (let d = 0; d < days; d++) {
    const dayStart = new Date(rangeStart.getTime() + d * dayMs);
    // Israel local 8:00 and 21:00
    const israelStart = new Date(dayStart);
    israelStart.setHours(8, 0, 0, 0);
    const israelEnd = new Date(dayStart);
    israelEnd.setHours(21, 0, 0, 0);

    const daySessions = sessions.filter(
      (s) => s.start < israelEnd && s.end > israelStart
    );

    let cursor = israelStart;
    for (const s of daySessions) {
      if (s.start.getTime() - cursor.getTime() >= minMinutes * 60_000) {
        gaps.push({
          start: cursor,
          end: s.start,
          minutes: Math.round((s.start.getTime() - cursor.getTime()) / 60_000),
          dayOfWeek: cursor.getDay(),
        });
      }
      if (s.end > cursor) cursor = s.end;
    }
    if (israelEnd.getTime() - cursor.getTime() >= minMinutes * 60_000) {
      gaps.push({
        start: cursor,
        end: israelEnd,
        minutes: Math.round((israelEnd.getTime() - cursor.getTime()) / 60_000),
        dayOfWeek: cursor.getDay(),
      });
    }
  }

  return gaps;
}

const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  });
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("he-IL", {
    day: "numeric",
    month: "numeric",
    timeZone: "Asia/Jerusalem",
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "LOVABLE_API_KEY is not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");

    const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: claimsData, error: claimsErr } = await supabaseAuth.auth.getClaims(token);
    if (claimsErr || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.claims.sub;

    // Service-role client for DB reads bypassing RLS in this trusted context
    const supabaseService = createClient(
      SUPABASE_URL,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Build context: range = today + next 7 days
    const now = new Date();
    const rangeStart = new Date(now);
    const rangeEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Pull calendar events via existing edge function (avoids re-implementing OAuth)
    let calendarEvents: CalendarEvent[] = [];
    try {
      const calRes = await fetch(
        `${SUPABASE_URL}/functions/v1/google-calendar-billing`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify({
            month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
          }),
        }
      );
      if (calRes.ok) {
        const calJson = await calRes.json();
        calendarEvents = calJson.events || [];
      }
    } catch (e) {
      console.warn("Could not fetch calendar:", e);
    }

    // Patients (sorted by created_at desc) — to detect new ones
    const { data: patients = [] } = await supabaseService
      .from("patients")
      .select("id, name, session_price, billing_type, created_at, mindme")
      .eq("therapist_id", userId)
      .order("created_at", { ascending: false });

    const recentPatients = (patients || []).filter((p: any) => {
      const created = new Date(p.created_at);
      return (now.getTime() - created.getTime()) / (24 * 60 * 60 * 1000) <= 14;
    });

    // Sessions completed in last 7 days
    const last7Start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const completedRecent = calendarEvents.filter((e) => {
      if (!isBillingEvent(e.colorId)) return false;
      const s = e.start.dateTime ? new Date(e.start.dateTime) : null;
      if (!s) return false;
      return s >= last7Start && s < now;
    });

    let totalRecentMinutes = 0;
    for (const e of completedRecent) {
      if (e.start.dateTime && e.end.dateTime) {
        totalRecentMinutes +=
          (new Date(e.end.dateTime).getTime() - new Date(e.start.dateTime).getTime()) / 60_000;
      }
    }
    const recentHours = Math.round(totalRecentMinutes / 60);

    // Future gaps (next 3 days, working hours 8-21, minimum 60 min)
    const next3Start = now;
    const next3End = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const gaps = findGaps(calendarEvents, next3Start, next3End, 60).slice(0, 8);

    // Build readable context for the AI
    const contextLines: string[] = [];
    contextLines.push(`היום: ${DAY_NAMES[now.getDay()]} ${fmtDate(now)} ${fmtTime(now)}`);
    contextLines.push(`שעות עבודה ב-7 הימים האחרונים: ${recentHours} שעות (${completedRecent.length} פגישות)`);

    if (recentPatients.length > 0) {
      contextLines.push(`\nמטופלים חדשים שנוספו ב-14 הימים האחרונים:`);
      for (const p of recentPatients) {
        const types: Record<string, string> = {
          monthly: "חיוב חודשי",
          per_session: "תשלום לפגישה",
          institution: "מוסד",
        };
        contextLines.push(
          `- ${p.name} (${types[p.billing_type] || "חודשי"}, ₪${p.session_price}${p.mindme ? ", MindMe" : ""})`
        );
      }
    }

    if (gaps.length > 0) {
      contextLines.push(`\nחלונות פנויים ב-3 הימים הקרובים (8:00-21:00, מינימום שעה):`);
      for (const g of gaps) {
        contextLines.push(
          `- ${DAY_NAMES[g.dayOfWeek]} ${fmtDate(g.start)} ${fmtTime(g.start)}-${fmtTime(g.end)} (${g.minutes} דקות)`
        );
      }
    } else {
      contextLines.push(`\nאין חלונות פנויים משמעותיים ב-3 הימים הקרובים.`);
    }

    const userContext = contextLines.join("\n");

    const systemPrompt = `אתה עוזר אישי חם ואנושי של מטפלת/מטפל בקליניקה פרטית.
המטרה שלך: לעזור למטפל לשמור על איזון בין עומס מקצועי לחיים אישיים — שינה, ספורט, תזונה, פנאי, מנוחה.

חוקים:
1. דבר בעברית בגוף שני (אתה/את — בחר לפי הנתונים אם ברור, אחרת השתמש בלשון רבים נייטרלית).
2. תן בדיוק 2-4 המלצות קונקרטיות, קצרות וברות-פעולה.
3. כל המלצה חייבת להיות מבוססת על נתון אמיתי שראית בהקשר — תזכיר אותו במפורש (למשל "יש לך חלון של 90 דקות ביום שני 14:00 — אימון כושר?").
4. אם נוספו מטופלים חדשים — הוסף המלצה אחת על זה (למשל הכנת תיק, חימום קצר לפני, הפרדת מנטלית בין מטופלים).
5. אל תהיה מטיף או חודרני. השתמש בטון תומך, ענייני, אמפתי.
6. אל תזכיר נתונים פיננסיים, כסף או חוב — אלה לא העניין שלך.
7. השב **רק** ב-JSON תקין במבנה: {"recommendations": [{"icon": "🏃", "title": "...", "body": "..."}]}.
   האייקונים: 🏃 ספורט, 🛌 שינה, 🥗 אוכל, ☕ הפסקה, 🧘 מנוחה/מדיטציה, 👤 מטופל חדש, 🚶 הליכה, 📚 לימוד.
8. ה-title קצר (עד 6 מילים). ה-body 1-2 משפטים, מסביר למה והמלצה ספציפית.`;

    const userPrompt = `הנה ההקשר שלי כרגע:\n\n${userContext}\n\nתן לי המלצות אישיות.`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "give_recommendations",
              description: "Return personalized recommendations",
              parameters: {
                type: "object",
                properties: {
                  recommendations: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        icon: { type: "string" },
                        title: { type: "string" },
                        body: { type: "string" },
                      },
                      required: ["icon", "title", "body"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["recommendations"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "give_recommendations" } },
      }),
    });

    if (!aiRes.ok) {
      if (aiRes.status === 429) {
        return new Response(
          JSON.stringify({ error: "rate_limited", message: "יותר מדי בקשות. נסה שוב בעוד דקה." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (aiRes.status === 402) {
        return new Response(
          JSON.stringify({
            error: "no_credits",
            message: "אין יתרה ב-Lovable AI. הוסף יתרה דרך Settings.",
          }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const t = await aiRes.text();
      console.error("AI gateway error:", aiRes.status, t);
      return new Response(JSON.stringify({ error: "ai_error", details: t }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiJson = await aiRes.json();
    const toolCall = aiJson.choices?.[0]?.message?.tool_calls?.[0];
    let recommendations: any[] = [];
    if (toolCall?.function?.arguments) {
      try {
        const parsed = JSON.parse(toolCall.function.arguments);
        recommendations = parsed.recommendations || [];
      } catch (e) {
        console.error("Failed to parse AI tool args:", e);
      }
    }

    return new Response(
      JSON.stringify({
        recommendations,
        context: {
          recentHours,
          recentSessionsCount: completedRecent.length,
          newPatientsCount: recentPatients.length,
          gapsCount: gaps.length,
        },
        generatedAt: new Date().toISOString(),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("personal-assistant error:", e);
    return new Response(
      JSON.stringify({ error: "server_error", message: e?.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
