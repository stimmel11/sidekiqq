/**
 * GET /offline — the one page the service worker precaches (docs/WEBAPP.md §1.1).
 * Plain HTML with inline styles and an inline SVG mark: no scripts, no external requests, no user
 * data, so it renders from the cache with no network and is safe to keep on the device.
 */

import { OFFLINE_CSP, OFFLINE_HTML } from "@/lib/pwa/offline";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Cacheable by the service worker (not no-store), revalidated by the browser on every load.
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Security-Policy": OFFLINE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    },
  });
}
