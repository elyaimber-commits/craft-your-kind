import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getFreshGoogleAccessToken } from "../_shared/google-token.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Lists Google Drive folders. Optional `q` query param filters by name (contains).
// Returns up to 50 folders, ordered by recently modified.
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
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims, error: cErr } = await supa.auth.getClaims(token);
    if (cErr || !claims?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claims.claims.sub as string;

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();

    const accessToken = await getFreshGoogleAccessToken(userId);

    // Build Drive query
    const parts = [
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
    ];
    if (q) {
      // Escape single quotes for Drive query
      const safe = q.replace(/'/g, "\\'");
      parts.push(`name contains '${safe}'`);
    }
    const driveQ = parts.join(" and ");

    const params = new URLSearchParams({
      q: driveQ,
      pageSize: "50",
      orderBy: "modifiedTime desc",
      fields: "files(id,name,parents,modifiedTime)",
      spaces: "drive",
    });

    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    const data = await resp.json();
    if (!resp.ok) {
      console.error("Drive list error:", data);
      return new Response(JSON.stringify({ error: data?.error?.message || "Drive error", detail: data }), {
        status: resp.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ folders: data.files || [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("google-drive-folders error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
