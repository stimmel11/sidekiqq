import type { Deps } from "../deps";

/** Read-only counts for the nav. Each lookup fails soft so the shell still renders when Redis is down. */
export async function navCounts(deps: Deps): Promise<{ overdue: number; drafts: number; followups: number }> {
  const safe = async (f: () => Promise<number>) => {
    try {
      return await f();
    } catch {
      return 0;
    }
  };
  const [overdue, drafts, followups] = await Promise.all([
    safe(async () => (await deps.repos.commitments.list("overdue")).length),
    safe(async () => (await deps.repos.drafts.listPending()).length),
    safe(async () => (await deps.repos.followups.list()).length),
  ]);
  return { overdue, drafts, followups };
}
