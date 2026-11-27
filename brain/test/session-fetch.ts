import { NextRequest } from "next/server";
import { SESSION_COOKIE, signSession } from "@/lib/dashboard/session";
import type { FetchLike } from "@/lib/dashboard/browser-api";
import { POST as approve } from "@/app/api/drafts/[id]/approve/route";
import { POST as discard } from "@/app/api/drafts/[id]/discard/route";
import { POST as complete } from "@/app/api/commitments/[id]/complete/route";
import { middleware } from "@/middleware";

/**
 * A `fetch` that behaves like the signed-in dashboard browser: same-origin, the session cookie
 * attached, the middleware run first, then the real route handler. Needs SESSION_SECRET and
 * TOKEN_ENCRYPTION_KEY in the env and `setDeps(deps)`.
 */
export type SessionFetch = FetchLike & { calls: { path: string; init: RequestInit }[] };

const ROUTES: [RegExp, typeof approve][] = [
  [/^\/api\/drafts\/([^/]+)\/approve$/, approve],
  [/^\/api\/drafts\/([^/]+)\/discard$/, discard],
  [/^\/api\/commitments\/([^/]+)\/complete$/, complete],
];

export async function sessionFetch(opts: { secret?: string; headers?: Record<string, string> } = {}): Promise<SessionFetch> {
  const cookie = `${SESSION_COOKIE}=${(await signSession(opts.secret ?? process.env.SESSION_SECRET!)).value}`;
  const calls: SessionFetch["calls"] = [];
  const fn = (async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    headers.set("origin", "http://localhost:3000");
    headers.set("sec-fetch-site", "same-origin");
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
    const req = new NextRequest(new URL(path, "http://localhost:3000"), { method: init.method, headers, ...(init.body != null ? { body: init.body } : {}) });
    const gate = await middleware(req);
    if (!gate.headers.has("x-middleware-next")) return gate;
    for (const [re, handler] of ROUTES) {
      const m = re.exec(new URL(path, "http://localhost:3000").pathname);
      if (m) return handler(req, { params: Promise.resolve({ id: decodeURIComponent(m[1]!) }) });
    }
    return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
  }) as SessionFetch;
  fn.calls = calls;
  return fn;
}
