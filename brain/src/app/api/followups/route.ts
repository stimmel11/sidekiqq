import { withDevice } from "@/lib/auth";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withDevice(async (_req, { deps }) => json({ items: await deps.repos.followups.list() }));
