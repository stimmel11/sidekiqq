import { withOwnerOrSession } from "@/lib/auth";
import { disconnect } from "@/lib/connectors/manage";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner only. Revokes at the provider (best effort) and deletes the stored credential. `{ ok: true, revoked }`. */
export const POST = withOwnerOrSession<{ connectorId: string }>(async (_req, { deps, params }) => json(await disconnect(deps, params.connectorId)));
