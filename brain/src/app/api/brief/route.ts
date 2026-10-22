import { withDevice } from "@/lib/auth";
import { generateBrief } from "@/lib/briefing";
import { json } from "@/lib/http";
import { BriefKindSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = withDevice(async (req, { deps }) => {
  const kind = BriefKindSchema.parse(req.nextUrl.searchParams.get("kind") ?? "daily");
  return json(await generateBrief(deps, kind));
});
