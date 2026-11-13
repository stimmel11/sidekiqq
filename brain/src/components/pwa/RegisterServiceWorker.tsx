"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js (offline shell only, see public/sw.js). Production builds only: `next dev`
 * serves unhashed /_next/static files that a cache-first worker would keep stale.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Not fatal: the app works without the worker, it just has no offline page.
    });
  }, []);
  return null;
}
