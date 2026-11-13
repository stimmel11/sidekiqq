import { readFileSync } from "node:fs";
import path from "node:path";

/** Deploy id baked into the worker's cache name. Only [A-Za-z0-9_-] so it can't break out of the JS string. */
export function swBuildId(env: Record<string, string | undefined> = process.env): string {
  const raw = env.VERCEL_DEPLOYMENT_ID || env.VERCEL_GIT_COMMIT_SHA || env.SK_BUILD_ID || "local";
  const id = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return id || "local";
}

export function swTemplate(): string {
  return readFileSync(path.join(process.cwd(), "src/lib/pwa/sw.template.js"), "utf8");
}

export function renderServiceWorker(buildId: string, template = swTemplate()): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(buildId)) throw new Error("invalid build id");
  return template.replaceAll("__SK_BUILD__", buildId);
}

/** The service worker must always be revalidated so a fix ships on the next load (docs/WEBAPP.md §8). */
export const SW_HEADERS: Record<string, string> = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "no-cache",
  "Service-Worker-Allowed": "/",
  "X-Content-Type-Options": "nosniff",
};
