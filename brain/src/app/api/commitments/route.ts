import { z } from "zod";
import { withDevice } from "@/lib/auth";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const StatusSchema = z.enum(["open", "overdue", "all"]);

export const GET = withDevice(async (req, { deps }) => {
  const status = StatusSchema.parse(req.nextUrl.searchParams.get("status") ?? "open");
  return json({ items: await deps.repos.commitments.list(status) });
});
