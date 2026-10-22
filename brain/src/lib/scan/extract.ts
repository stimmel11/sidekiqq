import { z } from "zod";
import {
  CATEGORIES,
  CONFIDENCE,
  IMPORTANCE,
  type Category,
  type Confidence,
  type Importance,
} from "../models";
import { config } from "../env";
import { normalizeOwnerDate } from "../util";

/**
 * Email → structured intelligence.
 *
 * `ExtractionToolSchema` is what Claude is asked to fill (JSON schema for the forced tool).
 * `parseExtraction` is deliberately lenient about what comes back: models drift on casing,
 * emit relative dates, invent categories, or omit fields. We normalise and drop junk
 * rather than rejecting the whole email.
 */

const commitmentShape = z.object({
  who: z.string().describe('Who promised. Use "Stimmel" when the owner promised.'),
  what: z.string().describe("What was promised, as a short imperative-style phrase."),
  dueAt: z.string().optional().describe("ISO-8601 date/datetime. If no deadline was stated, infer one and set dueInferred=true."),
  dueInferred: z.boolean().describe("true when dueAt was not explicitly stated."),
  confidence: z.enum(CONFIDENCE).describe("CONFIRMED explicit promise; LIKELY strongly implied; INFERRED your interpretation."),
});

export const ExtractionToolSchema = z.object({
  summary: z.string().describe("One or two factual sentences about what this email says."),
  categories: z.array(z.enum(CATEGORIES)).describe("One or more categories."),
  importance: z.enum(IMPORTANCE),
  importanceReason: z.string().describe("Why this importance; distinguish urgent vs important vs actionable vs informational."),
  client: z.string().optional().describe("Client/organization this relates to, if any. Omit for personal or noise."),
  project: z.string().optional(),
  people: z.array(z.string()).describe("People involved (names, or emails if no name)."),
  commitments: z.array(commitmentShape),
  decisions: z.array(
    z.object({
      what: z.string(),
      people: z.array(z.string()),
      why: z.string().optional(),
      impact: z.string().optional(),
      confidence: z.enum(CONFIDENCE),
    }),
  ),
  followups: z.array(
    z.object({
      person: z.string(),
      reason: z.string().describe('e.g. "Client asked about proposal status and is waiting"'),
      importance: z.enum(IMPORTANCE),
      suggestedMessage: z.string().optional().describe("A short draft reply in the owner's voice."),
    }),
  ),
  nextAction: z.string().optional().describe("The single most important next action, if any."),
  alert: z.string().optional().describe("For CRITICAL/HIGH only: one plain sentence suitable for a phone/watch notification."),
});

export interface ExtractedCommitment {
  who: string;
  what: string;
  dueAt?: string;
  dueInferred: boolean;
  confidence: Confidence;
}
export interface ExtractedDecision {
  what: string;
  people: string[];
  why?: string;
  impact?: string;
  confidence: Confidence;
}
export interface ExtractedFollowUp {
  person: string;
  reason: string;
  importance: Importance;
  suggestedMessage?: string;
}
export interface Extraction {
  summary: string;
  categories: Category[];
  importance: Importance;
  importanceReason?: string;
  client?: string;
  project?: string;
  people: string[];
  commitments: ExtractedCommitment[];
  decisions: ExtractedDecision[];
  followups: ExtractedFollowUp[];
  nextAction?: string;
  alert?: string;
}

const str = (v: unknown, max = 2000): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t || /^(n\/?a|none|null|unknown|-)$/i.test(t)) return undefined;
  return t.slice(0, max);
};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function enumOf<T extends string>(values: readonly T[], v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  const norm = v.trim().toLowerCase();
  return values.find((x) => x.toLowerCase() === norm) ?? fallback;
}

function bool(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.toLowerCase() === "true");
}

/**
 * Normalise a due date. Accepts ISO dates/datetimes; date-only values are pinned to 23:59 in
 * the OWNER's time zone (so "due Friday" is not overdue until Friday is over in Denver), and
 * zone-less datetimes are read as owner-local time rather than server UTC.
 * Unparseable/relative strings ("next week") return undefined.
 */
export function normalizeDue(v: unknown, timeZone = config.ownerTimezone()): string | undefined {
  const s = str(v, 100);
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}($|T)/.test(s)) return undefined;
  return normalizeOwnerDate(s, { timeZone, dateOnly: "endOfDay" });
}

export function parseCommitment(raw: unknown): ExtractedCommitment | null {
  const o = obj(raw);
  const who = str(o.who, 200);
  const what = str(o.what, 1000);
  if (!who || !what) return null;
  const dueAt = normalizeDue(o.dueAt ?? o.due ?? o.deadline);
  let confidence = enumOf(CONFIDENCE, o.confidence, "INFERRED");
  // A promise extracted without any confidence signal is at best LIKELY, never silently CONFIRMED.
  if (o.confidence === undefined) confidence = "LIKELY";
  return {
    who,
    what,
    ...(dueAt ? { dueAt } : {}),
    // No date → nothing to be inferred. Date present but flag missing → treat as inferred (safer).
    dueInferred: dueAt ? (o.dueInferred === undefined ? true : bool(o.dueInferred)) : false,
    confidence,
  };
}

export function parseExtraction(raw: unknown): Extraction {
  const o = obj(raw);
  const categories = [
    ...new Set(arr(o.categories).map((c) => enumOf(CATEGORIES, c, "FYI" as Category)).filter((c) => c)),
  ];
  const importance = enumOf(IMPORTANCE, o.importance, "LOW");
  const client = str(o.client, 200);
  const project = str(o.project, 200);
  const importanceReason = str(o.importanceReason, 500);
  const nextAction = str(o.nextAction, 500);
  const alert = str(o.alert, 300);
  return {
    summary: str(o.summary, 1000) ?? "(no summary)",
    categories: categories.length ? categories : ["FYI"],
    importance,
    ...(importanceReason ? { importanceReason } : {}),
    ...(client ? { client } : {}),
    ...(project ? { project } : {}),
    people: arr(o.people).map((p) => str(p, 200)).filter((p): p is string => !!p).slice(0, 20),
    commitments: arr(o.commitments).map(parseCommitment).filter((c): c is ExtractedCommitment => !!c).slice(0, 20),
    decisions: arr(o.decisions)
      .map((d): ExtractedDecision | null => {
        const x = obj(d);
        const what = str(x.what, 1000);
        if (!what) return null;
        const why = str(x.why);
        const impact = str(x.impact);
        return {
          what,
          people: arr(x.people).map((p) => str(p, 200)).filter((p): p is string => !!p),
          ...(why ? { why } : {}),
          ...(impact ? { impact } : {}),
          confidence: enumOf(CONFIDENCE, x.confidence, "LIKELY"),
        };
      })
      .filter((d): d is ExtractedDecision => !!d)
      .slice(0, 10),
    followups: arr(o.followups)
      .map((f): ExtractedFollowUp | null => {
        const x = obj(f);
        const person = str(x.person, 200);
        const reason = str(x.reason, 1000);
        if (!person || !reason) return null;
        const suggestedMessage = str(x.suggestedMessage, 4000);
        return { person, reason, importance: enumOf(IMPORTANCE, x.importance, "MEDIUM"), ...(suggestedMessage ? { suggestedMessage } : {}) };
      })
      .filter((f): f is ExtractedFollowUp => !!f)
      .slice(0, 10),
    ...(nextAction ? { nextAction } : {}),
    ...(alert ? { alert } : {}),
  };
}
