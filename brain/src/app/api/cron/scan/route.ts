import { requireCron } from "@/lib/auth";
import { getDeps } from "@/lib/deps";
import { GoogleNotConnectedError } from "@/lib/google/auth";
import { ConnectionUnusableError } from "@/lib/connectors/types";
import { config } from "@/lib/env";
import { errorResponse, json } from "@/lib/http";
import { runScan } from "@/lib/scan/scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron (every 30 min, see vercel.json) calls this with
 * `Authorization: Bearer $CRON_SECRET`. A Redis lock prevents overlapping runs.
 */
async function handle(req: Request): Promise<Response> {
  try {
    requireCron(req);
    const deps = getDeps();
    const lockKey = `${config.redisPrefix()}:lock:scan`;
    if (!(await deps.kv.set(lockKey, "1", { nx: true, exSeconds: 280 }))) {
      return json({ ok: true, skipped: "scan already running" });
    }
    try {
      const result = await runScan(deps);
      return json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof GoogleNotConnectedError || err instanceof ConnectionUnusableError) return json({ ok: false, error: err.message }, { status: 409 });
      throw err;
    } finally {
      await deps.kv.del(lockKey);
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// Vercel Cron issues GET; POST is accepted per the contract and for manual runs.
export const GET = handle;
export const POST = handle;
