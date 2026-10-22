import { z } from "zod";

/**
 * Centralised, lazily validated environment access.
 * Each getter validates only what it needs so that, e.g., a missing Deepgram key
 * never breaks `/api/ask`, and `next build` works without any secrets present.
 */

function read(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export class MissingEnvError extends Error {
  constructor(public readonly variable: string) {
    super(`Missing required environment variable ${variable}`);
    this.name = "MissingEnvError";
  }
}

export function required(name: string): string {
  const v = read(name);
  if (!v) throw new MissingEnvError(name);
  return v;
}

export function optional(name: string): string | undefined {
  return read(name);
}

function intEnv(name: string, fallback: number, min = 1): number {
  const raw = read(name);
  if (!raw) return fallback;
  const parsed = z.coerce.number().int().min(min).safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

export const config = {
  claudeModel: () => read("CLAUDE_MODEL") ?? "claude-sonnet-5-5",
  claudeMaxTokens: () => intEnv("CLAUDE_MAX_TOKENS", 2048, 256),
  maxToolIterations: () => intEnv("ASK_MAX_TOOL_ITERATIONS", 8),
  conversationTtlSeconds: () => intEnv("CONVERSATION_TTL_SECONDS", 6 * 60 * 60, 60),
  conversationMaxMessages: () => intEnv("CONVERSATION_MAX_MESSAGES", 24, 2),
  ownerName: () => read("OWNER_NAME") ?? "Stimmel",
  ownerTimezone: () => read("OWNER_TIMEZONE") ?? "America/Denver",
  scanMaxMessages: () => intEnv("SCAN_MAX_MESSAGES", 20),
  scanLookbackHours: () => intEnv("SCAN_LOOKBACK_HOURS", 24),
  pairCodeTtlSeconds: () => intEnv("PAIR_CODE_TTL_SECONDS", 600, 60),
  redisPrefix: () => read("REDIS_PREFIX") ?? "sk",
  appUrl: () => read("APP_URL") ?? (read("VERCEL_PROJECT_PRODUCTION_URL") ? `https://${read("VERCEL_PROJECT_PRODUCTION_URL")}` : "http://localhost:3000"),
};
