import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unauthenticated liveness probe. Reveals nothing about configuration. */
export function GET() {
  return json({ ok: true, service: "sidekiqq-brain" });
}
