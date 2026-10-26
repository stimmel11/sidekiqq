import { z } from "zod";
import type { Deps } from "../deps";
import { config } from "../env";
import { GoogleNotConnectedError } from "../google/auth";
import type { CalendarEvent } from "../google/workspace";
import { invokeCapability } from "../connectors/invoke";
import { structuredCall } from "../assistant/llm";
import { formatNow, systemBlocks } from "../assistant/prompt";
import {
  BriefSchema,
  IMPORTANCE,
  TopItemSchema,
  type Brief,
  type BriefKind,
  type Commitment,
  type FollowUp,
  type TopItem,
} from "../models";
import { IMPORTANCE_RANK, truncate } from "../util";

/**
 * Daily / end-of-day / weekly briefs and Top-5.
 * Data is gathered deterministically from the repos (+ calendar when connected), then Claude
 * writes the sections in the operating system's format. If the model call fails, a
 * deterministic brief is returned so wearables always get something useful.
 */

const SECTION_TITLES: Record<BriefKind, string[]> = {
  daily: ["TODAY", "CLIENTS", "MONEY", "COMMITMENTS", "RISKS", "OPPORTUNITIES"],
  eod: ["WHAT HAPPENED", "COMPLETED", "STILL OPEN", "BECAME URGENT", "NEW COMMITMENTS", "MISSED COMMITMENTS", "FOLLOW-UP NEEDED", "TOMORROW"],
  weekly: ["CLIENTS", "SALES", "PROJECTS", "COMMITMENTS", "FINANCIAL", "RELATIONSHIPS", "NEXT WEEK"],
};

interface Snapshot {
  now: Date;
  calendar: CalendarEvent[] | null;
  openCommitments: Commitment[];
  recentlyDone: Commitment[];
  followups: FollowUp[];
  timeline: { at: string; client?: string; event: string; importance: string }[];
  pendingDrafts: { id: string; to: string[]; subject: string; client?: string }[];
}

function windowFor(kind: BriefKind, now: Date) {
  const day = 86_400_000;
  if (kind === "weekly") return { since: new Date(now.getTime() - 7 * day), calEnd: new Date(now.getTime() + 7 * day) };
  if (kind === "eod") return { since: new Date(now.getTime() - day), calEnd: new Date(now.getTime() + 1.5 * day) };
  return { since: new Date(now.getTime() - 2 * day), calEnd: new Date(now.getTime() + day) };
}

async function snapshot(deps: Deps, kind: BriefKind): Promise<Snapshot> {
  const now = deps.clock();
  const { since, calEnd } = windowFor(kind, now);
  const { repos } = deps;

  let calendar: CalendarEvent[] | null = null;
  try {
    calendar = await invokeCapability(deps, "calendar.read", { timeMin: now.toISOString(), timeMax: calEnd.toISOString(), max: 25 }, { caller: "brief" });
  } catch (err) {
    if (!(err instanceof GoogleNotConnectedError)) console.warn("[brief] calendar unavailable", err);
  }

  const [all, followups, timeline, drafts] = await Promise.all([
    repos.commitments.list("all"),
    repos.followups.list(),
    repos.timeline.since(since.toISOString()),
    repos.drafts.listPending(),
  ]);
  const stored = await repos.commitments.allStored();
  const doneSince = new Set(
    stored.filter((c) => c.completedAt && Date.parse(c.completedAt) >= since.getTime()).map((c) => c.id),
  );
  return {
    now,
    calendar,
    openCommitments: all.filter((c) => c.status !== "done"),
    recentlyDone: all.filter((c) => doneSince.has(c.id)),
    followups,
    timeline: timeline
      .filter((e) => e.importance !== "FYI")
      .slice(-60)
      .map((e) => ({ at: e.at, ...(e.client ? { client: e.client } : {}), event: truncate(e.event, 300), importance: e.importance })),
    pendingDrafts: drafts.map((d) => ({ id: d.id, to: d.to, subject: d.subject, ...(d.client ? { client: d.client } : {}) })),
  };
}

// ---------------------------------------------------------------------------------------
// Deterministic Top-5 (also the fallback and the candidate list for the model)
// ---------------------------------------------------------------------------------------

type RankInput = Pick<Snapshot, "now" | "openCommitments" | "followups" | "pendingDrafts">;

export function rankTop5(s: RankInput): TopItem[] {
  return rankCandidates(s, 5);
}

/** Score every open item; highest first. */
export function rankCandidates(s: RankInput, limit: number): TopItem[] {
  const now = s.now.getTime();
  const candidates: (TopItem & { score: number })[] = [];
  for (const c of s.openCommitments) {
    const due = c.dueAt ? Date.parse(c.dueAt) : undefined;
    const overdue = c.status === "overdue";
    const soon = due !== undefined && due - now < 2 * 86_400_000;
    const importance = overdue ? "HIGH" : soon ? "HIGH" : due !== undefined ? "MEDIUM" : "LOW";
    candidates.push({
      id: c.id,
      title: truncate(`${c.who.toLowerCase() === config.ownerName().toLowerCase() ? "" : `${c.who}: `}${c.what}`, 120),
      why: overdue
        ? `Overdue${c.dueInferred ? " (inferred due date)" : ""}${c.client ? ` for ${c.client}` : ""}`
        : soon
          ? `Due soon${c.dueInferred ? " (inferred)" : ""}${c.client ? ` for ${c.client}` : ""}`
          : `Open commitment${c.client ? ` for ${c.client}` : ""}`,
      importance,
      ...(c.dueAt ? { dueAt: c.dueAt } : {}),
      score: IMPORTANCE_RANK[importance] * 10 + (overdue ? 8 : 0) + (soon ? 4 : 0),
    });
  }
  for (const f of s.followups) {
    candidates.push({
      id: f.id,
      title: truncate(`Follow up with ${f.person}${f.client ? ` (${f.client})` : ""}`, 120),
      why: truncate(`${f.reason}${f.daysQuiet ? ` (${f.daysQuiet} days quiet)` : ""}`, 200),
      importance: f.importance,
      score: IMPORTANCE_RANK[f.importance] * 10 + Math.min(f.daysQuiet ?? 0, 14) / 2,
    });
  }
  for (const d of s.pendingDrafts) {
    candidates.push({
      id: d.id,
      title: truncate(`Approve or discard draft: ${d.subject}`, 120),
      why: `Draft to ${d.to.join(", ")} is waiting for your approval`,
      importance: "MEDIUM",
      score: IMPORTANCE_RANK.MEDIUM * 10 + 1,
    });
  }
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _s, ...t }) => t);
}

const ModelTop5Schema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().describe("Must be one of the candidate ids."),
        title: z.string(),
        why: z.string(),
        importance: z.enum(IMPORTANCE),
      }),
    )
    .max(5),
});

const ModelBriefSchema = z.object({
  sections: z.array(z.object({ title: z.string(), items: z.array(z.string()) })),
  top5: ModelTop5Schema.shape.items,
});

function snapshotText(s: Snapshot, candidates: TopItem[]): string {
  return JSON.stringify(
    {
      now: s.now.toISOString(),
      calendar: s.calendar ?? "Google not connected",
      openCommitments: s.openCommitments,
      recentlyCompleted: s.recentlyDone,
      followups: s.followups,
      recentTimeline: s.timeline,
      pendingDrafts: s.pendingDrafts,
      top5Candidates: candidates,
    },
    null,
    0,
  );
}

/** Merge model-chosen items with candidate data (keeps dueAt, drops unknown ids). */
function reconcileTop5(modelItems: z.infer<typeof ModelTop5Schema>["items"], candidates: TopItem[]): TopItem[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: TopItem[] = [];
  for (const m of modelItems) {
    const c = byId.get(m.id);
    if (!c || out.some((o) => o.id === m.id)) continue;
    const parsed = TopItemSchema.safeParse({
      id: c.id,
      title: truncate(m.title || c.title, 120),
      why: truncate(m.why || c.why, 240),
      importance: m.importance,
      ...(c.dueAt ? { dueAt: c.dueAt } : {}),
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out.length ? out : candidates.slice(0, 5);
}

export async function computeTop5(deps: Deps): Promise<{ items: TopItem[]; updatedAt: string }> {
  const cached = await deps.repos.state.getTop5();
  if (cached) return cached;
  const s = await snapshot(deps, "daily");
  const candidates = rankCandidates(s, 15);
  let items: TopItem[] = candidates.slice(0, 5);
  if (candidates.length > 5) {
    try {
      const raw = await structuredCall(deps.llm(), {
        system: await systemBlocks(`Current time: ${formatNow(s.now)}. Produce the owner's TOP 5 ACTIONS.`),
        user: `Choose the five most important actions for today from top5Candidates, ranked by business impact, urgency, relationship importance, deadline and consequence of inaction. Use only candidate ids. Keep titles under 12 words and why under 20 words; say "inferred" when a due date is inferred.\n\n${snapshotText(s, candidates)}`,
        toolName: "set_top5",
        toolDescription: "Set today's top five actions.",
        schema: ModelTop5Schema,
        maxTokens: 1024,
      });
      const parsed = ModelTop5Schema.safeParse(raw);
      if (parsed.success) items = reconcileTop5(parsed.data.items, candidates);
    } catch (err) {
      console.warn("[top5] model ranking failed; using deterministic ranking", err);
    }
  }
  const value = { items, updatedAt: deps.clock().toISOString() };
  await deps.repos.state.setTop5(value);
  return value;
}

export function fallbackBrief(kind: BriefKind, s: Snapshot, top5: TopItem[]): Brief {
  const fmtC = (c: Commitment) =>
    `${c.who}: ${c.what}${c.dueAt ? ` (due ${c.dueAt.slice(0, 10)}${c.dueInferred ? ", inferred" : ""})` : ""}${c.client ? ` [${c.client}]` : ""}`;
  const overdue = s.openCommitments.filter((c) => c.status === "overdue");
  const sections = [
    {
      title: kind === "weekly" ? "NEXT WEEK" : "TODAY",
      items: s.calendar ? s.calendar.slice(0, 10).map((e) => `${e.start.slice(11, 16) || "All day"} ${e.summary}`) : ["Calendar unavailable (Google not connected)."],
    },
    { title: "COMMITMENTS", items: s.openCommitments.filter((c) => c.status === "open").slice(0, 10).map(fmtC) },
    { title: "OVERDUE", items: overdue.slice(0, 10).map(fmtC) },
    { title: "FOLLOW-UPS", items: s.followups.slice(0, 10).map((f) => `${f.person}${f.client ? ` (${f.client})` : ""}: ${f.reason}`) },
    { title: "AWAITING YOUR APPROVAL", items: s.pendingDrafts.map((d) => `Draft to ${d.to.join(", ")}: ${d.subject}`) },
    ...(kind !== "daily" ? [{ title: "COMPLETED", items: s.recentlyDone.slice(0, 10).map(fmtC) }] : []),
  ].filter((sec) => sec.items.length);
  return BriefSchema.parse({ kind, generatedAt: s.now.toISOString(), sections, top5 });
}

export async function generateBrief(deps: Deps, kind: BriefKind): Promise<Brief> {
  const s = await snapshot(deps, kind);
  const candidates = rankCandidates(s, 15);
  const deterministicTop5 = candidates.slice(0, 5);
  const titles = SECTION_TITLES[kind];
  const label = kind === "daily" ? "DAILY EXECUTIVE BRIEFING" : kind === "eod" ? "END-OF-DAY REVIEW" : "WEEKLY EXECUTIVE REVIEW";
  try {
    const raw = await structuredCall(deps.llm(), {
      system: await systemBlocks(`Current time: ${formatNow(s.now)}. You are producing the owner's ${label} for a wearable/phone display.`),
      user: [
        `Produce the ${label} using exactly these section titles in order: ${titles.join(", ")}.`,
        "Each item is one short plain-text line (no markdown), at most 8 items per section; omit a section only if there is truly nothing.",
        "Use only the data below. Label inferred dates as inferred. Keep each client's details in its own lines; do not merge clients.",
        "top5 must use ids from top5Candidates.",
        "",
        snapshotText(s, candidates),
      ].join("\n"),
      toolName: "publish_brief",
      toolDescription: `Publish the ${label}.`,
      schema: ModelBriefSchema,
      maxTokens: 3000,
    });
    const parsed = ModelBriefSchema.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.message);
    const sections = parsed.data.sections
      .map((sec) => ({ title: truncate(sec.title.trim().toUpperCase(), 60), items: sec.items.map((i) => truncate(i.trim(), 300)).filter(Boolean).slice(0, 12) }))
      .filter((sec) => sec.title);
    const top5 = reconcileTop5(parsed.data.top5, candidates);
    if (kind === "daily") await deps.repos.state.setTop5({ items: top5, updatedAt: s.now.toISOString() });
    return BriefSchema.parse({ kind, generatedAt: s.now.toISOString(), sections, top5 });
  } catch (err) {
    console.warn(`[brief] model brief failed; returning deterministic ${kind} brief`, err);
    return fallbackBrief(kind, s, deterministicTop5);
  }
}
