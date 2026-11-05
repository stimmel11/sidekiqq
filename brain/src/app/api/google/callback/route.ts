import { getDeps } from "@/lib/deps";
import { googleOAuth } from "@/lib/connectors/google/oauth";
import { CONNECT_RESULT_TEXT, type ConnectResult } from "@/lib/connectors/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(status: number, title: string, message: string): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font-family:system-ui;margin:2rem;max-width:36rem"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/dashboard/connections">Back to Connections</a></p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

/**
 * Google's OAuth redirect target (the registered redirect URI). Validates `state`, exchanges the
 * code, stores the refresh token encrypted. Shared with the generic connections flow; this one
 * shows a small page, `/api/connections/google/callback` redirects to the dashboard.
 */
export async function GET(req: Request): Promise<Response> {
  let result: ConnectResult;
  try {
    result = await googleOAuth.complete(getDeps(), new URL(req.url).searchParams);
  } catch (err) {
    console.error("[google] callback failed", err);
    result = { code: "failed" };
  }
  if (result.code === "connected") {
    return page(
      200,
      "Google connected",
      `SideKiqq can now read Gmail, Calendar, Drive and Contacts for ${result.account ?? "your account"} and create drafts. It never sends without your approval.`,
    );
  }
  const t = CONNECT_RESULT_TEXT[result.code];
  return page(t.status, result.code === "cancelled" ? "Google connection cancelled" : t.title, result.detail ?? t.message);
}
