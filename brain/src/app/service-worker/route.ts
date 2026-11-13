/**
 * GET /service-worker — the offline-shell service worker (src/lib/pwa/sw.template.js), rendered at build time
 * with the deploy id in its cache name so each deploy installs a fresh worker and drops the old cache.
 */
import { SW_HEADERS, renderServiceWorker, swBuildId } from "@/lib/pwa/sw";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(renderServiceWorker(swBuildId()), { status: 200, headers: SW_HEADERS });
}
