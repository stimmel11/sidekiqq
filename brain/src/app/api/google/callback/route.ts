import { google } from "googleapis";
import { getDeps } from "@/lib/deps";
import { createOAuthClient } from "@/lib/google/auth";
import { optional } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(status: number, title: string, message: string): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font-family:system-ui;margin:2rem;max-width:36rem"><h1>${esc(title)}</h1><p>${esc(message)}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

/** OAuth redirect target. Validates `state`, exchanges the code, stores the refresh token encrypted. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) return page(400, "Google connection cancelled", `Google returned: ${error}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return page(400, "Invalid callback", "Missing code or state.");

  try {
    const deps = getDeps();
    if (!(await deps.googleTokens.consumeState(state))) return page(400, "Link expired", "Start again from /api/google/connect.");

    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    let refreshToken = tokens.refresh_token ?? undefined;
    if (!refreshToken) {
      const existing = await deps.googleTokens.load();
      refreshToken = existing?.refreshToken;
    }
    if (!refreshToken) {
      return page(400, "No refresh token", "Google did not return a refresh token. Remove SideKiqq's access at myaccount.google.com/permissions and connect again.");
    }
    client.setCredentials(tokens);
    const profile = await google.gmail({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress ?? undefined;

    const allowed = optional("GOOGLE_ALLOWED_EMAIL");
    if (allowed && email?.toLowerCase() !== allowed.toLowerCase()) {
      return page(403, "Wrong account", `This SideKiqq brain only accepts ${allowed}.`);
    }

    await deps.googleTokens.save({
      refreshToken,
      ...(email ? { email } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      connectedAt: new Date().toISOString(),
    });
    return page(200, "Google connected", `SideKiqq can now read Gmail, Calendar and Drive for ${email ?? "your account"} and create drafts. It never sends without your approval.`);
  } catch (err) {
    console.error("[google] callback failed", err);
    return page(500, "Connection failed", "Could not complete Google sign-in. Check server logs.");
  }
}
