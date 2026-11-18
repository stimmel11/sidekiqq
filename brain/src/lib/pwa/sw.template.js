/*
 * SideKiqq service worker: offline shell ONLY (docs/WEBAPP.md §1.1), plus alert notifications (§5).
 * Template: GET /service-worker (src/app/service-worker/route.ts) serves this file with __SK_BUILD__ replaced by the
 * deploy id, so every deploy changes the worker's bytes, the browser reinstalls it, and activate
 * drops the previous deploy's cache (old /_next/static chunks included).
 *
 * Dashboard pages are server-rendered with the owner's data in the HTML, so pages are never cached.
 * This worker:
 *   - precaches the static /offline page, the icons and the manifest;
 *   - serves /_next/static/* (content-hashed, no user data) cache-first;
 *   - serves navigations to /dashboard* and /login network-only, with /offline as the fallback;
 *   - leaves every other request alone: /api/*, /auth/*, OAuth callbacks, RSC fetches (?_rsc=),
 *     server-action POSTs. No background sync, no queued approvals.
 * Nothing with a non-200 status or Cache-Control: no-store is ever stored. (A worker never sees
 * Set-Cookie, a forbidden response header; what keeps cookie-bearing responses out is that only the
 * precache list and /_next/static/* are ever stored.)
 * The precached manifest and icons follow the spec's allowlist; the fetch handler doesn't serve them.
 *
 * Web Push (docs/WEBAPP.md §5): `push` always shows a notification (no silent pushes) built only
 * from the payload's title/body/kind. A tap opens or focuses a same-origin dashboard path picked
 * from ALERT_PATHS by `kind`; a URL in the payload is never used. No notification actions, so
 * nothing can be confirmed or sent from a notification.
 */
"use strict";

const CACHE = "sk-shell-__SK_BUILD__";
const CACHE_PREFIX = "sk-shell-";
const OFFLINE_URL = "/offline";
const STATIC_PREFIX = "/_next/static/";
const PRECACHE = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

function isCacheable(res) {
  if (!res || res.status !== 200 || res.type !== "basic") return false;
  return !/no-store/i.test(res.headers.get("cache-control") || "");
}

function isShellNavigation(req, url) {
  if (req.mode !== "navigate") return false;
  if (url.searchParams.has("_rsc") || req.headers.get("rsc") === "1") return false;
  const p = url.pathname;
  return p === "/login" || p === "/dashboard" || p.startsWith("/dashboard/");
}

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    PRECACHE.map(async (path) => {
      const res = await fetch(new Request(path, { cache: "reload", credentials: "same-origin" }));
      if (!isCacheable(res)) throw new Error(`precache refused ${path} (${res.status})`);
      await cache.put(path, res);
    }),
  );
}

async function networkOrOffline(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE });
    return offline || new Response("You're offline. SideKiqq needs a connection.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (isCacheable(res)) await cache.put(req, res.clone());
  return res;
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // server actions, approvals, every POST: untouched
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(STATIC_PREFIX)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (isShellNavigation(req, url)) event.respondWith(networkOrOffline(req));
  // Everything else (/api/*, /auth/*, callbacks, RSC, images, the manifest) goes to the network as if no worker existed.
});

// ---- Web Push alerts -------------------------------------------------------------------------

const ALERT_PATHS = {
  email: "/dashboard",
  commitment_overdue: "/dashboard/commitments",
  connection_needs_reauth: "/dashboard/connections",
};
const DEFAULT_ALERT_PATH = "/dashboard";
const ALERT_TITLE_MAX = 120;
const ALERT_BODY_MAX = 600;

function alertPath(kind) {
  return typeof kind === "string" && Object.prototype.hasOwnProperty.call(ALERT_PATHS, kind) ? ALERT_PATHS[kind] : DEFAULT_ALERT_PATH;
}

function clipText(v, max) {
  if (typeof v !== "string") return "";
  const t = v.trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "\u2026";
}

/** Only title/body/kind are read from the payload; a bad payload still shows a generic alert. */
function alertFromPush(data) {
  let d = null;
  try {
    d = data ? data.json() : null;
  } catch (err) {
    d = null;
  }
  if (!d || typeof d !== "object") d = {};
  const kind = typeof d.kind === "string" && Object.prototype.hasOwnProperty.call(ALERT_PATHS, d.kind) ? d.kind : null;
  return {
    title: clipText(d.title, ALERT_TITLE_MAX) || "SideKiqq",
    options: {
      body: clipText(d.body, ALERT_BODY_MAX) || "You have a new alert.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: kind ? "sk-" + kind : "sk-alert",
      renotify: true,
      requireInteraction: d.importance === "CRITICAL",
      data: { kind: kind },
    },
  };
}

self.addEventListener("push", (event) => {
  const alert = alertFromPush(event.data);
  event.waitUntil(self.registration.showNotification(alert.title, alert.options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const path = alertPath(data && data.kind);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        let u = null;
        try {
          u = new URL(w.url);
        } catch (err) {
          u = null;
        }
        if (u && u.origin === self.location.origin && (u.pathname === "/dashboard" || u.pathname.startsWith("/dashboard/"))) {
          return w.focus().then((fw) => (fw && typeof fw.navigate === "function" ? fw.navigate(path) : fw));
        }
      }
      return self.clients.openWindow(path);
    }),
  );
});
