import { withDevice } from "@/lib/auth";
import { computeTop5 } from "@/lib/briefing";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = withDevice(async (_req, { deps }) => json(await computeTop5(deps)));
