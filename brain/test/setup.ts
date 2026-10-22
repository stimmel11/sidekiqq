import { afterEach } from "vitest";
import { setDeps } from "@/lib/deps";

process.env.OWNER_SECRET = "test-owner-secret-0123456789";
process.env.CRON_SECRET = "test-cron-secret";
process.env.CLAUDE_MODEL = "claude-test-model";
process.env.SYSTEM_PROMPT_PATH ??= `${process.cwd()}/prompts/operating-system.md`;
// Guard: tests must never reach real providers.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.DEEPGRAM_API_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

afterEach(() => setDeps(null));
