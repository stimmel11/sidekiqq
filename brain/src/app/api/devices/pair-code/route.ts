import { z } from "zod";
import { withOwner } from "@/lib/auth";
import { config } from "@/lib/env";
import { HttpError, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ label: z.string().trim().max(64).optional() }).default({});

/**
 * Owner-only: mint a one-time 6-digit pairing code (default 10 min TTL).
 * Auth: `Authorization: Bearer <OWNER_SECRET>` or `X-Owner-Secret`.
 */
export const POST = withOwner(async (req, { deps }) => {
  const text = await req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Body must be valid JSON");
    }
  }
  const body = Body.parse(raw);
  const ttl = config.pairCodeTtlSeconds();
  const { code, expiresAt } = await deps.repos.pairing.issue(ttl, body.label);
  return json({ code, expiresAt, ttlSeconds: ttl });
});
