// Shared helper to fetch a fresh Google access token for the authenticated user.
// Refreshes the token if it's expired or about to expire.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function getFreshGoogleAccessToken(userId: string): Promise<string> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: row, error } = await admin
    .from("google_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(`google_tokens lookup failed: ${error.message}`);
  if (!row) throw new Error("Google account not connected");

  const expiresAt = new Date(row.expires_at).getTime();
  // Refresh if less than 60s left
  if (expiresAt - Date.now() > 60_000) {
    return row.access_token as string;
  }

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
  if (!resp.ok) {
    throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  }

  const newAccessToken = data.access_token as string;
  const newExpiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();

  await admin
    .from("google_tokens")
    .update({ access_token: newAccessToken, expires_at: newExpiresAt })
    .eq("user_id", userId);

  return newAccessToken;
}
