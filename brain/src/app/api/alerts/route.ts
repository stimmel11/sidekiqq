import { withDevice } from "@/lib/auth";
import { HttpError, json } from "@/lib/http";
import { AlertsResponseSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/alerts?since=<cursor>&limit=<1..100>
 * Proactive alerts (identical content to the FCM pushes) for devices that cannot receive FCM.
 * Returns oldest first. Store `cursor` and send it back as `since` next time. When `more` is
 * true, call again immediately. Without `since`, returns the last 24 h.
 */
export const GET = withDevice(async (req, { deps }) => {
  const sp = req.nextUrl.searchParams;
  const rawSince = sp.get("since");
  let since: number | null = null;
  if (rawSince !== null && rawSince !== "") {
    if (!/^\d{1,15}$/.test(rawSince)) throw new HttpError(400, "since must be a cursor returned by /api/alerts", "bad_cursor");
    since = Number(rawSince);
  }
  const rawLimit = sp.get("limit");
  const limit = rawLimit ? Number(rawLimit) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "limit must be 1-100");
  const page = await deps.repos.alerts.since(since, limit);
  return json(AlertsResponseSchema.parse(page), { headers: { "Cache-Control": "no-store" } });
});
