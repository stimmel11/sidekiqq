import type { NextConfig } from "next";

/** The service worker must always be revalidated so a fix ships on the next load (docs/WEBAPP.md §8). */
export const PWA_HEADERS = [
  {
    source: "/sw.js",
    headers: [
      { key: "Cache-Control", value: "no-cache" },
      { key: "Service-Worker-Allowed", value: "/" },
      { key: "Content-Type", value: "application/javascript; charset=utf-8" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ],
  },
];

const nextConfig: NextConfig = {
  // Heavy Node-only SDKs: keep them out of the bundle and load them from node_modules at runtime.
  serverExternalPackages: ["firebase-admin", "googleapis"],
  // The Claude system prompt is read from disk at runtime; make sure Vercel ships it with every function.
  outputFileTracingIncludes: {
    "/api/**/*": ["./prompts/**/*"],
  },
  poweredByHeader: false,
  async headers() {
    return PWA_HEADERS;
  },
};

export default nextConfig;
