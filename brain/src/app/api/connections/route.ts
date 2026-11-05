import { withOwnerOrSession } from "@/lib/auth";
import { listConnections } from "@/lib/connectors/manage";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner only (owner secret header or dashboard session; never a device token). docs/CONNECTORS.md §9. */
export const GET = withOwnerOrSession(async (_req, { deps }) => json({ items: await listConnections(deps) }));
