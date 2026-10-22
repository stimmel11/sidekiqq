import type { KV } from "../kv";
import { CommitmentSchema, StoredCommitmentSchema, type Commitment, type Confidence, type StoredCommitment } from "../models";
import { newId, normalizeDate, sameClient, slugify } from "../util";
import { Collection } from "./collection";

export type CommitmentFilter = "open" | "overdue" | "all";

export interface NewCommitment {
  who: string;
  what: string;
  madeAt?: string;
  dueAt?: string;
  dueInferred?: boolean;
  client?: string;
  project?: string;
  source: Commitment["source"];
  confidence: Confidence;
  notes?: string;
}

export interface CommitmentPatch {
  what?: string;
  dueAt?: string | null;
  dueInferred?: boolean;
  status?: "open" | "done";
  client?: string;
  project?: string;
  notes?: string;
  confidence?: Confidence;
}

/** Derive contract status: an open commitment past its due date is "overdue". */
export function effectiveStatus(c: StoredCommitment, now: Date): Commitment["status"] {
  if (c.status === "done") return "done";
  if (c.dueAt && Date.parse(c.dueAt) < now.getTime()) return "overdue";
  return "open";
}

/** Strip internal fields and apply derived status → exact contract shape. */
export function toContract(c: StoredCommitment, now: Date): Commitment {
  return CommitmentSchema.parse({ ...c, status: effectiveStatus(c, now) });
}

/** Dedup key so repeated scans of the same thread don't create duplicates. */
export function commitmentFingerprint(c: Pick<NewCommitment, "who" | "what" | "source">): string {
  return [slugify(c.who), slugify(c.what).slice(0, 80), c.source.ref ?? ""].join("|");
}

export class CommitmentsRepo {
  private readonly col: Collection<StoredCommitment>;
  constructor(kv: KV, prefix: string, private readonly clock: () => Date = () => new Date()) {
    this.col = new Collection(kv, prefix, "commitments", StoredCommitmentSchema);
  }

  async add(input: NewCommitment): Promise<{ commitment: StoredCommitment; created: boolean }> {
    const fp = commitmentFingerprint(input);
    const existing = (await this.col.all()).find((c) => commitmentFingerprint(c) === fp);
    if (existing) return { commitment: existing, created: false };

    const now = this.clock().toISOString();
    const dueAt = normalizeDate(input.dueAt);
    const record: StoredCommitment = {
      id: newId("cmt"),
      who: input.who,
      what: input.what,
      madeAt: normalizeDate(input.madeAt) ?? now,
      ...(dueAt ? { dueAt } : {}),
      dueInferred: dueAt ? Boolean(input.dueInferred) : false,
      status: "open",
      ...(input.client ? { client: input.client } : {}),
      ...(input.project ? { project: input.project } : {}),
      source: input.source,
      confidence: input.confidence,
      ...(input.notes ? { notes: input.notes } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return { commitment: await this.col.put(record), created: true };
  }

  get(id: string) {
    return this.col.get(id);
  }

  async update(id: string, patch: CommitmentPatch): Promise<StoredCommitment | null> {
    const cur = await this.col.get(id);
    if (!cur) return null;
    const now = this.clock().toISOString();
    const next: StoredCommitment = { ...cur, updatedAt: now };
    if (patch.what !== undefined) next.what = patch.what;
    if (patch.client !== undefined) next.client = patch.client;
    if (patch.project !== undefined) next.project = patch.project;
    if (patch.notes !== undefined) next.notes = patch.notes;
    if (patch.confidence !== undefined) next.confidence = patch.confidence;
    if (patch.dueAt === null) {
      delete next.dueAt;
      next.dueInferred = false;
    } else if (patch.dueAt !== undefined) {
      const d = normalizeDate(patch.dueAt);
      if (d) next.dueAt = d;
    }
    if (patch.dueInferred !== undefined && next.dueAt) next.dueInferred = patch.dueInferred;
    if (patch.status === "done" && cur.status !== "done") {
      next.status = "done";
      next.completedAt = now;
    } else if (patch.status === "open") {
      next.status = "open";
      delete next.completedAt;
    }
    return this.col.put(next);
  }

  async complete(id: string): Promise<StoredCommitment | null> {
    return this.update(id, { status: "done" });
  }

  /** Contract-shaped list, soonest due first (undated last). */
  async list(filter: CommitmentFilter = "open", opts: { client?: string } = {}): Promise<Commitment[]> {
    const now = this.clock();
    const rows = (await this.col.all())
      .filter((c) => !opts.client || sameClient(c.client, opts.client))
      .map((c) => toContract(c, now))
      .filter((c) => {
        if (filter === "all") return true;
        if (filter === "overdue") return c.status === "overdue";
        return c.status === "open" || c.status === "overdue"; // "open" = not done
      });
    return rows.sort((a, b) => {
      const da = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
      const db = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
      return da - db || Date.parse(a.madeAt) - Date.parse(b.madeAt);
    });
  }

  allStored() {
    return this.col.all();
  }
}
