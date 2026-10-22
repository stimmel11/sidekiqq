import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Heavy Node-only SDKs: keep them out of the bundle and load them from node_modules at runtime.
  serverExternalPackages: ["firebase-admin", "googleapis"],
  // The Claude system prompt is read from disk at runtime; make sure Vercel ships it with every function.
  outputFileTracingIncludes: {
    "/api/**/*": ["./prompts/**/*"],
  },
  poweredByHeader: false,
};

export default nextConfig;
