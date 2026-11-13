/*
 * SideKiqq service worker: offline shell ONLY (docs/WEBAPP.md §1.1).
 *
 * Dashboard pages are server-rendered with the owner's data in the HTML, so pages are never cached.
 * This worker:
 *   - precaches the static /offline page, the icons and the manifest;
 *   - serves /_next/static/* (content-hashed, no user data) cache-first;
 *   - serves navigations to /dashboard* and /login network-only, with /offline as the fallback;
 *   - leaves every other request alone: /api/*, /auth/*, OAuth callbacks, RSC fetches (?_rsc=),
 *     server-action POSTs. No background sync, no queued approvals.
 * Nothing with Set-Cookie, a non-200 status or Cache-Control: no-store is ever stored.
 */
"use strict";

const CACHE = "sk-shell-v1";
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
  if (res.headers.has("set-cookie")) return false;
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
      const res = await fetch(new Request(path, { cache: "reload", credentials: "omit" }));
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
