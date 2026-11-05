import { z } from "zod";
import { withOwnerOrSession } from "@/lib/auth";
import { setCapabilities } from "@/lib/connectors/manage";
import { json, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ enabled: z.array(z.string().max(100)).max(50) });

/**
 * Owner only. `{ enabled: CapabilityId[] }` → `Connection`. Only this connector's own capabilities
 * are accepted (400 otherwise); tiers are fixed in code and no capability is a send path.
 */
export const POST = withOwnerOrSession<{ connectorId: string }>(async (req, { deps, params }) => {
  const { enabled } = await parseJson(req, Body);
  return json(await setCapabilities(deps, params.connectorId, enabled));
});
