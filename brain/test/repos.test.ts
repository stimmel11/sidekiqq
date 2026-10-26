import { describe, expect, it } from "vitest";
import { CommitmentSchema, FollowUpSchema } from "@/lib/models";
import { decrypt, encrypt } from "@/lib/crypto";
import { randomBytes } from "node:crypto";
import { makeDeps } from "./fakes";

describe("commitments repo", () => {
  it("adds, dedups, derives overdue, completes, and returns exact contract shape", async () => {
    const deps = makeDeps({ now: new Date("2026-10-16T15:00:00Z") });
    const repo = deps.repos.commitments;

    const a = await repo.add({ who: "Stimmel", what: "Send revised proposal", dueAt: "2026-10-15T17:00:00Z", dueInferred: false, client: "ACME", source: { kind: "voice" }, confidence: "CONFIRMED" });
    const b = await repo.add({ who: "Dana", what: "Send deposit", dueAt: "2026-10-20", dueInferred: true, client: "Outcrop Retreat Co", source: { kind: "email", ref: "m1" }, confidence: "LIKELY" });
    const dup = await repo.add({ who: "Dana", what: "send deposit!", source: { kind: "email", ref: "m1" }, confidence: "LIKELY" });
    expect(a.created && b.created).toBe(true);
    expect(dup.created).toBe(false);
    expect(dup.commitment.id).toBe(b.commitment.id);

    const overdue = await repo.list("overdue");
    expect(overdue.map((c) => c.id)).toEqual([a.commitment.id]);
    expect(overdue[0]!.status).toBe("overdue");

    const open = await repo.list("open");
    expect(open).toHaveLength(2);
    for (const c of open) {
      expect(CommitmentSchema.strict().safeParse(c).success).toBe(true); // no internal fields leak
    }

    await repo.complete(a.commitment.id);
    expect((await repo.list("overdue"))).toHaveLength(0);
    const all = await repo.list("all");
    expect(all.find((c) => c.id === a.commitment.id)?.status).toBe("done");
    expect(await repo.list("open", { client: "acme" })).toHaveLength(0);
    expect(await repo.list("all", { client: "ACME " })).toHaveLength(1);
  });

  it("clears dueInferred when the due date is removed", async () => {
    const deps = makeDeps();
    const { commitment } = await deps.repos.commitments.add({ who: "X", what: "Y", dueAt: "2026-11-01", dueInferred: true, source: { kind: "voice" }, confidence: "INFERRED" });
    const updated = await deps.repos.commitments.update(commitment.id, { dueAt: null });
    expect(updated?.dueAt).toBeUndefined();
    expect(updated?.dueInferred).toBe(false);
  });
});

describe("followups repo", () => {
  it("upserts per person+client, keeps highest importance, computes daysQuiet", async () => {
    const deps = makeDeps({ now: new Date("2026-10-16T15:00:00Z") });
    const r1 = await deps.repos.followups.upsert({ person: "Dana Lee", client: "ACME", reason: "Waiting on proposal", importance: "HIGH", lastContactAt: "2026-10-07T15:00:00Z" });
    const r2 = await deps.repos.followups.upsert({ person: "dana lee", client: "ACME", reason: "Still waiting", importance: "MEDIUM" });
    await deps.repos.followups.upsert({ person: "Sam", reason: "Intro", importance: "LOW" });
    expect(r2.created).toBe(false);
    expect(r2.followUp.id).toBe(r1.followUp.id);
    const list = await deps.repos.followups.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ person: "Dana Lee", importance: "HIGH", reason: "Still waiting", daysQuiet: 9 });
    for (const f of list) expect(FollowUpSchema.strict().safeParse(f).success).toBe(true);
    await deps.repos.followups.resolve(r1.followUp.id);
    expect(await deps.repos.followups.list()).toHaveLength(1);
  });
});

describe("clients, timeline, decisions", () => {
  it("merges client profiles without clobbering fields", async () => {
    const deps = makeDeps();
    await deps.repos.clients.upsert({ name: "ACME Corp", email: "a@acme.com", relationshipHealth: "Healthy" });
    const { client, created } = await deps.repos.clients.upsert({ name: "acme corp", nextAction: "Send pricing" });
    expect(created).toBe(false);
    expect(client).toMatchObject({ name: "ACME Corp", email: "a@acme.com", relationshipHealth: "Healthy", nextAction: "Send pricing" });
  });

  it("returns a single client's timeline in chronological order without other clients", async () => {
    const deps = makeDeps();
    await deps.repos.timeline.add({ client: "ACME", at: "2026-10-10T00:00:00Z", event: "second" });
    await deps.repos.timeline.add({ client: "Globex", at: "2026-10-09T00:00:00Z", event: "other client" });
    await deps.repos.timeline.add({ client: "acme", at: "2026-10-01T00:00:00Z", event: "first" });
    const events = await deps.repos.timeline.forClient("ACME");
    expect(events.map((e) => e.event)).toEqual(["first", "second"]);
  });

  it("stores decisions with defaults", async () => {
    const deps = makeDeps();
    const d = await deps.repos.decisions.add({ what: "Go with tier B pricing", client: "ACME" });
    expect(d.confidence).toBe("CONFIRMED");
    expect(await deps.repos.decisions.list({ client: "ACME" })).toHaveLength(1);
    expect(await deps.repos.decisions.list({ client: "Globex" })).toHaveLength(0);
  });
});

describe("drafts + conversations + state", () => {
  it("drafts start pending; send lock is exclusive", async () => {
    const deps = makeDeps();
    const d = await deps.repos.drafts.create({ gmailDraftId: "g1", to: ["a@b.co"], subject: "s", body: "b" });
    expect(d.status).toBe("pending");
    expect(await deps.repos.drafts.acquireSendLock(d.id)).toBe(true);
    expect(await deps.repos.drafts.acquireSendLock(d.id)).toBe(false);
    await deps.repos.drafts.releaseSendLock(d.id);
    expect(await deps.repos.drafts.acquireSendLock(d.id)).toBe(true);
  });

  it("conversation history is capped, starts with a user turn, and expires", async () => {
    const deps = makeDeps();
    const at = deps.clock().toISOString();
    for (let i = 0; i < 15; i++) {
      await deps.repos.conversations.append("c1", [
        { role: "user", content: `q${i}`, at },
        { role: "assistant", content: `a${i}`, at },
      ]);
    }
    const h = await deps.repos.conversations.load("c1");
    expect(h.length).toBeLessThanOrEqual(20);
    expect(h[0]!.role).toBe("user");
    expect(h.at(-1)!.content).toBe("a14");
    deps.setNow(new Date(deps.clock().getTime() + 3601_000));
    expect(await deps.repos.conversations.load("c1")).toEqual([]);
  });

  it("skips corrupt rows instead of throwing", async () => {
    const deps = makeDeps();
    await deps.kv.hset("t:commitments", "bad", "{not json");
    await deps.kv.hset("t:commitments", "bad2", JSON.stringify({ id: "bad2" }));
    expect(await deps.repos.commitments.list("all")).toEqual([]);
  });
});

describe("google token encryption", () => {
  it("round-trips AES-256-GCM and rejects tampering / wrong AAD", async () => {
    const key = randomBytes(32);
    const ct = encrypt("refresh-token-xyz", key, "aad");
    expect(ct).not.toContain("refresh-token-xyz");
    expect(decrypt(ct, key, "aad")).toBe("refresh-token-xyz");
    expect(() => decrypt(ct, key, "other")).toThrow();
    const parts = ct.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."), key, "aad")).toThrow();
  });

  it("stores the refresh token encrypted in KV", async () => {
    const deps = makeDeps();
    await deps.googleTokens.save({ refreshToken: "1//secret-refresh", connectedAt: new Date().toISOString() });
    const raw = await deps.kv.get("t:conn:google:tokens");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("secret-refresh");
    expect((await deps.googleTokens.load())?.refreshToken).toBe("1//secret-refresh");
  });
});
