import { afterEach, describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { makeDeps, msg, req, ScriptedLLM, toolUse } from "./fakes";
import { GET as scan } from "@/app/api/cron/scan/route";
import { GET as connectGet, POST as connectPost } from "@/app/api/google/connect/route";
import { executeTool } from "@/lib/assistant/tools";
import { buildMulticast, INVALID_TOKEN_CODES } from "@/lib/push";
import { localDay, normalizeOwnerDate } from "@/lib/util";
import type { EmailMessage } from "@/lib/google/workspace";

/** Regression tests for defects found in the QA review (see QA_REPORT.md). */

const OWNER = { "x-owner-secret": "test-owner-secret-0123456789" };

function email(id: string, minutesAgo: number): EmailMessage {
  return {
    id,
    threadId: `t_${id}`,
    from: "Dana Lee <dana@acme.com>",
    to: "stimmel@example.com",
    cc: "",
    subject: `Msg ${id}`,
    date: new Date(Date.parse("2026-10-16T15:00:00Z") - minutesAgo * 60_000).toISOString(),
    snippet: "",
    labels: ["INBOX"],
    body: "hello",
  };
}

const fyi = () =>
  msg([toolUse("record_email_analysis", { summary: "ok", categories: ["FYI"], importance: "FYI", people: [], commitments: [], decisions: [], followups: [] })]);

afterEach(() => {
  delete process.env.SCAN_MAX_MESSAGES;
});

describe("scan backlog (more mail than SCAN_MAX_MESSAGES)", () => {
  it("drains every message across runs, oldest first, and holds the cursor until done", async () => {
    process.env.SCAN_MAX_MESSAGES = "2";
    const llm = new ScriptedLLM([fyi]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    // Gmail order: newest first.
    deps.ws.messages = [email("m5", 1), email("m4", 2), email("m3", 3), email("m2", 4), email("m1", 5)];
    const run = async () => (await (await scan(req("GET", "/api/cron/scan", { token: "test-cron-secret" }))).json()) as Record<string, number>;

    const r1 = await run();
    expect(r1).toMatchObject({ processed: 2, backlog: 3 });
    expect(await deps.repos.state.getLastScan()).toBeNull(); // cursor held
    const firstBatch = llm.calls.map((c) => /Message-Id: (\w+)/.exec(c.messages[0]!.content as string)?.[1]).sort();
    expect(firstBatch).toEqual(["m1", "m2"]); // oldest first

    expect(await run()).toMatchObject({ processed: 2, backlog: 1, skipped: 2 });
    expect(await run()).toMatchObject({ processed: 1, backlog: 0 });
    expect(await deps.repos.state.getLastScan()).not.toBeNull();
    expect(llm.calls).toHaveLength(5); // each message analysed exactly once
  });
});

describe("owner time zone (America/Denver)", () => {
  it("normalizeOwnerDate handles date-only, zone-less and zoned inputs across DST", () => {
    const tz = "America/Denver";
    expect(normalizeOwnerDate("2026-10-23", { timeZone: tz })).toBe("2026-10-24T05:59:00.000Z");
    expect(normalizeOwnerDate("2026-10-23", { timeZone: tz, dateOnly: "startOfDay" })).toBe("2026-10-23T06:00:00.000Z");
    expect(normalizeOwnerDate("2026-11-02", { timeZone: tz, dateOnly: "startOfDay" })).toBe("2026-11-02T07:00:00.000Z");
    expect(normalizeOwnerDate("2026-10-23T09:30", { timeZone: tz })).toBe("2026-10-23T15:30:00.000Z");
    expect(normalizeOwnerDate("2026-10-23T09:30:00+02:00", { timeZone: tz })).toBe("2026-10-23T07:30:00.000Z");
    expect(normalizeOwnerDate("garbage", { timeZone: tz })).toBeUndefined();
    expect(localDay(new Date("2026-10-17T02:00:00Z"), tz)).toBe("2026-10-16"); // 8pm MDT is still the 16th
  });

  it("a voice commitment due '2026-10-23' is not overdue until Denver midnight", async () => {
    const deps = makeDeps({ now: new Date("2026-10-23T23:30:00Z") }); // 5:30pm MDT
    const { commitment } = await deps.repos.commitments.add({ who: "Stimmel", what: "Send pricing", dueAt: "2026-10-23", source: { kind: "voice" }, confidence: "CONFIRMED" });
    expect(commitment.dueAt).toBe("2026-10-24T05:59:00.000Z");
    expect((await deps.repos.commitments.list("overdue")).length).toBe(0);
    deps.setNow(new Date("2026-10-24T06:00:00Z")); // just after midnight MDT
    expect((await deps.repos.commitments.list("overdue")).length).toBe(1);
  });

  it("update_commitment with a zone-less time uses owner-local time", async () => {
    const deps = makeDeps();
    const { commitment } = await deps.repos.commitments.add({ who: "Stimmel", what: "Call Dana", source: { kind: "voice" }, confidence: "CONFIRMED" });
    const updated = await deps.repos.commitments.update(commitment.id, { dueAt: "2026-10-20T17:00:00" });
    expect(updated?.dueAt).toBe("2026-10-20T23:00:00.000Z");
  });

  it("list_calendar_events treats date-only bounds as the owner's local day", async () => {
    const deps = makeDeps();
    const spy = vi.spyOn(deps.ws, "listCalendarEvents");
    const out = await executeTool("list_calendar_events", { start: "2026-10-20", end: "2026-10-20" }, { deps, now: deps.clock(), device: "watch", actions: [] });
    expect(out.isError).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ timeMin: "2026-10-20T06:00:00.000Z", timeMax: "2026-10-21T05:59:00.000Z" }));
  });
});

describe("commitment and follow-up dedup", () => {
  it("a recurring voice commitment can be re-added after the previous one is done", async () => {
    const deps = makeDeps();
    const a = await deps.repos.commitments.add({ who: "Stimmel", what: "Call Dana", source: { kind: "voice" }, confidence: "CONFIRMED" });
    expect((await deps.repos.commitments.add({ who: "Stimmel", what: "Call Dana", source: { kind: "voice" }, confidence: "CONFIRMED" })).created).toBe(false);
    await deps.repos.commitments.complete(a.commitment.id);
    expect((await deps.repos.commitments.add({ who: "Stimmel", what: "Call Dana", source: { kind: "voice" }, confidence: "CONFIRMED" })).created).toBe(true);
  });

  it("email commitments still dedup against completed ones from the same message", async () => {
    const deps = makeDeps();
    const src = { kind: "email" as const, ref: "m1" };
    const a = await deps.repos.commitments.add({ who: "Dana", what: "Send deposit", source: src, confidence: "CONFIRMED" });
    await deps.repos.commitments.complete(a.commitment.id);
    expect((await deps.repos.commitments.add({ who: "Dana", what: "Send deposit", source: src, confidence: "CONFIRMED" })).created).toBe(false);
  });

  it("follow-ups merge when the client name differs only in case/spacing", async () => {
    const deps = makeDeps();
    await deps.repos.followups.upsert({ person: "Dana", client: "ACME Corp", reason: "a", importance: "LOW" });
    const second = await deps.repos.followups.upsert({ person: "dana", client: "acme corp ", reason: "b", importance: "HIGH" });
    expect(second.created).toBe(false);
    expect(await deps.repos.followups.list()).toHaveLength(1);
  });
});

describe("FCM payload", () => {
  it("is data-only so the phone app always handles it (watch relay + medallion haptic)", () => {
    const m = buildMulticast(["t1"], { title: "Important: Dana", body: "Waiting on proposal", data: { kind: "email", importance: "HIGH" }, priority: "high" });
    expect(m).not.toHaveProperty("notification");
    expect(m.android).toEqual({ priority: "high" });
    expect(m.data).toMatchObject({ title: "Important: Dana", body: "Waiting on proposal", kind: "email", importance: "HIGH" });
  });

  it("does not treat payload errors as invalid tokens", () => {
    expect(INVALID_TOKEN_CODES.has("messaging/invalid-argument")).toBe(false);
    expect(INVALID_TOKEN_CODES.has("messaging/registration-token-not-registered")).toBe(true);
  });
});

describe("/api/google/connect never takes the owner secret in the URL", () => {
  it("refuses ?secret=, requires owner auth, and issues single-use tickets", async () => {
    process.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "csecret";
    process.env.APP_URL = "https://brain.example.com";
    try {
      const deps = makeDeps();
      setDeps(deps);
      expect((await connectGet(req("GET", "/api/google/connect?secret=test-owner-secret-0123456789"))).status).toBe(400);
      expect((await connectGet(req("GET", "/api/google/connect"))).status).toBe(401);
      expect((await connectGet(req("GET", "/api/google/connect?ticket=not-a-real-ticket-123"))).status).toBe(401);
      expect((await connectPost(req("POST", "/api/google/connect"))).status).toBe(401);

      const res = await connectPost(req("POST", "/api/google/connect", { headers: OWNER }));
      expect(res.status).toBe(200);
      const { url } = (await res.json()) as { url: string };
      const link = new URL(url);
      expect(link.origin).toBe("https://brain.example.com");
      expect(link.searchParams.has("secret")).toBe(false);

      const first = await connectGet(req("GET", `${link.pathname}${link.search}`));
      expect(first.status).toBe(307);
      expect(first.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
      // Single use.
      expect((await connectGet(req("GET", `${link.pathname}${link.search}`))).status).toBe(401);
      // Header auth still works for scripted use.
      expect((await connectGet(req("GET", "/api/google/connect", { headers: OWNER }))).status).toBe(307);
    } finally {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.APP_URL;
    }
  });
});
