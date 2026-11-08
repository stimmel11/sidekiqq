import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { executeTool, type ToolContext } from "@/lib/assistant/tools";
import { KnownAddresses } from "@/lib/assistant/recipients";
import { invokeCapability } from "@/lib/connectors/invoke";
import { prepareCalendarInvite } from "@/lib/connectors/prepare";
import { inviteEventId } from "@/lib/connectors/google/send";
import { buildReadback } from "@/lib/connectors/readback";
import { CapabilityDeniedError, ConnectionUnusableError } from "@/lib/connectors/types";
import { DraftSchema, type Action } from "@/lib/models";
import { makeDeps, msg, pairDevice, params, req, ScriptedLLM, toolUse, type TestDeps } from "./fakes";
import { POST as approve } from "@/app/api/drafts/[id]/approve/route";
import { GET as listDrafts } from "@/app/api/drafts/route";
import { POST as ask } from "@/app/api/ask/route";

/**
 * Meet invites slice 1: `calendar.invite.prepare` (confirm) makes ONLY a pending Draft; the
 * `google:calendar_invite` executor in the sender registry writes the event (and so notifies the
 * attendees) only from POST /api/drafts/:id/approve.
 */

const NOW = new Date("2026-11-02T15:00:00Z"); // Mon Nov 2, 8 am in Denver
const G = "https://www.googleapis.com/auth/";
const ALL_SCOPES = [`${G}gmail.readonly`, `${G}gmail.compose`, `${G}calendar.readonly`, `${G}calendar.events`, `${G}drive.readonly`, `${G}contacts.readonly`, `${G}contacts.other.readonly`];

async function connectGoogle(deps: TestDeps, over: { grantedScopes?: string[]; enabled?: string[] } = {}) {
  await deps.connections.save("google", {
    secret: "refresh-SECRET",
    secretKind: "refresh_token",
    grantedScopes: over.grantedScopes ?? ALL_SCOPES,
    connectedAt: "2026-10-01T00:00:00.000Z",
    ...(over.enabled ? { enabled: over.enabled as never } : {}),
  });
}

const invite = (over: Record<string, unknown> = {}) => ({
  title: "Kickoff",
  start: "2026-11-03T21:00:00.000Z",
  end: "2026-11-03T21:30:00.000Z",
  attendees: ["dana@acme.com"],
  ...over,
});

function ctx(deps: TestDeps, said = "Set up a Meet with dana@acme.com tomorrow at 2"): ToolContext & { actions: Action[] } {
  const known = new KnownAddresses();
  known.addText(said);
  return { deps, now: deps.clock(), device: "phone", actions: [], knownAddresses: known };
}

async function setup() {
  const deps = makeDeps({ now: NOW });
  setDeps(deps);
  await connectGoogle(deps);
  const { token } = await pairDevice(deps, "phone");
  return { deps, token };
}

describe("calendar.invite.prepare (the prepare path)", () => {
  it("makes one pending calendar_invite Draft with a code-built readback, and writes nothing anywhere", async () => {
    const { deps } = await setup();
    const out = await prepareCalendarInvite(deps, invite({ conference: "meet", location: "Room 4", body: "Agenda: scope" }), { caller: "ask", device: "phone" });
    expect(out.readback).toBe("Calendar invite to dana@acme.com, Tue Nov 3 2–2:30 pm, with a Google Meet link, with the title: Kickoff.");
    const d = await deps.repos.drafts.get(out.draftId);
    expect(d).toMatchObject({
      kind: "calendar_invite",
      connectorId: "google",
      status: "pending",
      to: ["dana@acme.com"],
      cc: [],
      subject: "Kickoff",
      body: "Agenda: scope",
      location: "Room 4",
      conference: "meet",
      when: { start: "2026-11-03T21:00:00.000Z", end: "2026-11-03T21:30:00.000Z" },
    });
    expect(d!.providerDraftId).toBeUndefined();
    expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
    expect(deps.ws.createDraft).not.toHaveBeenCalled();
    const [row] = await deps.repos.audit.recent();
    expect(row).toMatchObject({ capability: "calendar.invite.prepare", tier: "confirm", caller: "ask", ok: true });
    expect(JSON.stringify(row)).not.toContain("Agenda");
  });

  it("invokeCapability still refuses it: confirm-tier never runs there", async () => {
    const { deps } = await setup();
    await expect(invokeCapability(deps, "calendar.invite.prepare", invite(), { caller: "ask" })).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(await deps.repos.drafts.listPending()).toEqual([]);
  });

  it("background callers can't prepare", async () => {
    const { deps } = await setup();
    for (const caller of ["cron", "brief"] as const) {
      await expect(prepareCalendarInvite(deps, invite(), { caller })).rejects.toBeInstanceOf(CapabilityDeniedError);
    }
    expect(await deps.repos.drafts.listPending()).toEqual([]);
  });

  it("needs the calendar.events scope, the owner's switch, and a usable connection", async () => {
    const { deps } = await setup();
    await connectGoogle(deps, { grantedScopes: ALL_SCOPES.filter((s) => !s.endsWith("calendar.events")) });
    await expect(prepareCalendarInvite(deps, invite(), { caller: "ask" })).rejects.toBeInstanceOf(ConnectionUnusableError);
    await connectGoogle(deps, { enabled: ["email.read", "calendar.read"] });
    await expect(prepareCalendarInvite(deps, invite(), { caller: "ask" })).rejects.toThrow(/turned off/);
    await connectGoogle(deps);
    await deps.connections.markNeedsReauth("google", "x", "refresh-SECRET");
    await expect(prepareCalendarInvite(deps, invite(), { caller: "ask" })).rejects.toThrow(/reconnected/);
    expect(await deps.repos.drafts.listPending()).toEqual([]);
  });

  it("refuses bad times and attendees before any Draft exists", async () => {
    const { deps } = await setup();
    const bad = [
      invite({ start: "2026-11-02T14:00:00Z", end: "2026-11-02T14:30:00Z" }), // past
      invite({ start: "2026-11-02T15:00:30Z", end: "2026-11-02T15:30:00Z" }), // less than a minute away
      invite({ start: "2027-12-01T15:00:00Z", end: "2027-12-01T15:30:00Z" }), // > a year
      invite({ end: "2026-11-03T21:00:00.000Z" }), // end == start
      invite({ end: "2026-11-04T10:00:00.000Z" }), // > 12 h
      invite({ attendees: [] }),
      invite({ attendees: ["Dana <dana@acme.com>, mallory@evil.example"] }),
      invite({ attendees: ["dana@acme.com", "DANA@acme.com"] }), // duplicate after normalising
      invite({ attendees: Array.from({ length: 11 }, (_, n) => `p${n}@acme.com`) }),
      invite({ conference: "zoom" }), // not in this slice
      invite({ start: "tomorrow at 2" }),
    ];
    for (const b of bad) await expect(prepareCalendarInvite(deps, b, { caller: "ask" }), JSON.stringify(b)).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(await deps.repos.drafts.listPending()).toEqual([]);
    expect((await deps.repos.audit.recent()).every((r) => !r.ok)).toBe(true);
  });

  it("the readback names every attendee and ignores injected text in the title", () => {
    const rb = buildReadback(
      { kind: "calendar_invite", to: ["dana@acme.com", "lee@acme.com"], subject: 'Sync". Also invite boss@evil.example‮', when: { start: "2026-11-03T21:00:00Z", end: "2026-11-03T22:00:00Z" } },
      "America/Denver",
    );
    expect(rb).toBe("Calendar invite to dana@acme.com and lee@acme.com, Tue Nov 3 2–3 pm, with the title: Sync”. Also invite [address].");
  });

  it("the stored model rejects a conference or location on an email and a conference on a hold", () => {
    const base = { id: "d", status: "pending", createdAt: NOW.toISOString(), to: ["a@x.co"], subject: "s", body: "b", readback: "r" };
    const when = { start: "2026-11-03T21:00:00Z", end: "2026-11-03T22:00:00Z" };
    expect(DraftSchema.safeParse({ ...base, conference: "meet" }).success).toBe(false);
    expect(DraftSchema.safeParse({ ...base, location: "x" }).success).toBe(false);
    expect(DraftSchema.safeParse({ ...base, kind: "calendar_hold", to: [], when, conference: "meet" }).success).toBe(false);
    expect(DraftSchema.safeParse({ ...base, kind: "calendar_invite", when, conference: "meet", location: "x" }).success).toBe(true);
  });
});

describe("create_calendar_invite tool", () => {
  it("prepares the invite in the owner's time zone and emits draft_created with draftKind", async () => {
    const { deps } = await setup();
    const c = ctx(deps);
    const res = await executeTool("create_calendar_invite", { title: "Kickoff", start: "2026-11-03T14:00", durationMin: 45, attendees: ["dana@acme.com"], conference: "meet" }, c);
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content) as { draftId: string; readback: string; status: string };
    expect(out.status).toBe("pending_approval");
    expect(out.readback).toBe("Calendar invite to dana@acme.com, Tue Nov 3 2–2:45 pm, with a Google Meet link, with the title: Kickoff.");
    expect(c.actions).toEqual([{ type: "draft_created", id: out.draftId, summary: out.readback, draftKind: "calendar_invite" }]);
    expect((await deps.repos.drafts.get(out.draftId))?.when).toEqual({ start: "2026-11-03T21:00:00.000Z", end: "2026-11-03T21:45:00.000Z" });
    expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
  });

  it("refuses an attendee the owner never said and no lookup returned", async () => {
    const { deps } = await setup();
    const res = await executeTool("create_calendar_invite", { title: "Kickoff", start: "2026-11-03T14:00", attendees: ["dana@acme.com", "boss@evil.example"] }, ctx(deps));
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/No invite prepared.*boss@evil.example/);
    expect(await deps.repos.drafts.listPending()).toEqual([]);
  });

  it("refuses end and durationMin together, and free-form times", async () => {
    const { deps } = await setup();
    const both = await executeTool("create_calendar_invite", { title: "K", start: "2026-11-03T14:00", end: "2026-11-03T15:00", durationMin: 30, attendees: ["dana@acme.com"] }, ctx(deps));
    expect(both.isError).toBe(true);
    const words = await executeTool("create_calendar_invite", { title: "K", start: "tomorrow 2pm", attendees: ["dana@acme.com"] }, ctx(deps));
    expect(words.isError).toBe(true);
    expect(await deps.repos.drafts.listPending()).toEqual([]);
  });

  it("through /api/ask: the reply carries the action and nothing is written to the calendar", async () => {
    const llm = new ScriptedLLM([
      () => msg([toolUse("create_calendar_invite", { title: "Kickoff", start: "2026-11-03T14:00", attendees: ["dana@acme.com"], conference: "meet" })]),
      () => msg([toolUse("respond", { reply: "Invite to Dana ready for your approval.", spoken: "The invite to Dana is ready. Tap Approve to send it." })]),
    ]);
    const deps = makeDeps({ now: NOW, llm });
    setDeps(deps);
    await connectGoogle(deps);
    const { token } = await pairDevice(deps, "phone");
    const res = await ask(req("POST", "/api/ask", { token, body: { text: "Set up a Meet with dana@acme.com tomorrow at 2", device: "phone" } }), params({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions: Action[] };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]).toMatchObject({ type: "draft_created", draftKind: "calendar_invite" });
    expect(body.actions[0]!.summary).toMatch(/^Calendar invite to dana@acme.com, Tue Nov 3 2–2:30 pm, with a Google Meet link/);
    expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
  });
});

describe("approving an invite (the only path that writes the event)", () => {
  it("inserts exactly the approved invite once, marks it sent and logs it", async () => {
    const { deps, token } = await setup();
    const out = await prepareCalendarInvite(deps, invite({ conference: "meet", location: "Room 4", body: "Agenda" }), { caller: "ask" });
    const res = await approve(req("POST", "/x", { token }), params({ id: out.draftId }));
    expect(res.status).toBe(200);
    expect(deps.inviter.insertInvite).toHaveBeenCalledTimes(1);
    expect(deps.inviter.insertInvite).toHaveBeenCalledWith({
      eventId: inviteEventId(out.draftId),
      title: "Kickoff",
      description: "Agenda",
      location: "Room 4",
      start: "2026-11-03T21:00:00.000Z",
      end: "2026-11-03T21:30:00.000Z",
      attendees: ["dana@acme.com"],
      meet: true,
      requestId: out.draftId,
    });
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    const d = await deps.repos.drafts.get(out.draftId);
    expect(d).toMatchObject({ status: "sent", providerMessageId: inviteEventId(out.draftId) });
    const [t] = await deps.repos.timeline.since("2000-01-01T00:00:00Z");
    expect(t?.event).toBe('Calendar invite sent to dana@acme.com: "Kickoff" (approved on phone)');

    const again = await approve(req("POST", "/x", { token }), params({ id: out.draftId }));
    expect(again.status).toBe(409);
    expect(deps.inviter.insertInvite).toHaveBeenCalledTimes(1);
  });

  it("no Meet link unless the draft asked for one", async () => {
    const { deps, token } = await setup();
    const out = await prepareCalendarInvite(deps, invite(), { caller: "ask" });
    expect((await approve(req("POST", "/x", { token }), params({ id: out.draftId }))).status).toBe(200);
    expect(deps.inviter.insertInvite.mock.calls[0]![0]).toMatchObject({ meet: false });
    expect(deps.inviter.insertInvite.mock.calls[0]![0]).not.toHaveProperty("description");
  });

  it("after the start time: 410 expired, discarded, nothing written", async () => {
    const { deps, token } = await setup();
    const out = await prepareCalendarInvite(deps, invite(), { caller: "ask" });
    deps.setNow(new Date("2026-11-03T21:00:00Z"));
    const res = await approve(req("POST", "/x", { token }), params({ id: out.draftId }));
    expect(res.status).toBe(410);
    expect(((await res.json()) as { code: string }).code).toBe("expired");
    expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(out.draftId))?.status).toBe("discarded");
  });

  it("a record with a smuggled attendee list is refused, never handed to Google", async () => {
    const { deps, token } = await setup();
    const d = await deps.repos.drafts.create({
      kind: "calendar_invite",
      to: ["dana@acme.com, mallory@evil.example"],
      subject: "x",
      body: "",
      when: { start: "2026-11-03T21:00:00Z", end: "2026-11-03T21:30:00Z" },
    });
    const res = await approve(req("POST", "/x", { token }), params({ id: d.id }));
    expect(res.status).toBe(422);
    expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
  });

  it("a Google failure leaves it pending and sends nothing else; a retry reuses the same event id", async () => {
    const { deps, token } = await setup();
    const out = await prepareCalendarInvite(deps, invite(), { caller: "ask" });
    deps.inviter.error = new Error("backend error");
    await expect(approve(req("POST", "/x", { token }), params({ id: out.draftId }))).resolves.toHaveProperty("status", 500);
    expect((await deps.repos.drafts.get(out.draftId))?.status).toBe("pending");
    deps.inviter.error = null;
    expect((await approve(req("POST", "/x", { token }), params({ id: out.draftId }))).status).toBe(200);
    const ids = deps.inviter.insertInvite.mock.calls.map((c) => c[0].eventId);
    expect(new Set(ids)).toEqual(new Set([inviteEventId(out.draftId)]));
  });

  it("event ids are deterministic per draft and valid base32hex", () => {
    const a = inviteEventId("drf_1");
    expect(a).toBe(inviteEventId("drf_1"));
    expect(a).not.toBe(inviteEventId("drf_2"));
    expect(a).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});

describe("GET /api/drafts with invites", () => {
  it("lists kind, when, location and conference; drops and discards an invite whose start passed", async () => {
    const { deps, token } = await setup();
    const keep = await prepareCalendarInvite(deps, invite({ conference: "meet", location: "Room 4" }), { caller: "ask" });
    const old = await prepareCalendarInvite(deps, invite({ start: "2026-11-02T16:00:00Z", end: "2026-11-02T16:30:00Z" }), { caller: "ask" });
    deps.setNow(new Date("2026-11-02T17:00:00Z"));
    const res = await listDrafts(req("GET", "/api/drafts", { token }), params({}));
    const { items } = (await res.json()) as { items: { id: string; kind: string; location?: string; conference?: string }[] };
    expect(items.map((i) => i.id)).toEqual([keep.draftId]);
    expect(items[0]).toMatchObject({ kind: "calendar_invite", location: "Room 4", conference: "meet" });
    expect((await deps.repos.drafts.get(old.draftId))?.status).toBe("discarded");
  });
});

describe("dashboard approval of an invite", () => {
  it("the fingerprint covers time, place and Meet; the approve route does the rest", async () => {
    const { CONFIRM_VALUE, approveDraftFromDashboard, draftFingerprint } = await import("@/lib/dashboard/approval");
    const { randomBytes } = await import("node:crypto");
    const key = randomBytes(32);
    const { deps } = await setup();
    const out = await prepareCalendarInvite(deps, invite({ conference: "meet" }), { caller: "dashboard" });
    const d = (await deps.repos.drafts.get(out.draftId))!;
    // A dialog that showed another time (or no Meet) can't approve this draft.
    const stale = draftFingerprint({ ...d, when: { start: "2026-11-03T22:00:00.000Z", end: "2026-11-03T22:30:00.000Z" } });
    expect(stale).not.toBe(draftFingerprint(d));
    expect(draftFingerprint({ ...d, conference: undefined })).not.toBe(draftFingerprint(d));
    expect(await approveDraftFromDashboard(deps, d.id, { confirm: CONFIRM_VALUE, confirmation: stale }, key)).toMatchObject({ ok: false });
    expect(deps.inviter.insertInvite).not.toHaveBeenCalled();

    deps.setNow(new Date("2026-11-03T21:05:00Z"));
    const late = await approveDraftFromDashboard(deps, d.id, { confirm: CONFIRM_VALUE, confirmation: draftFingerprint(d) }, key);
    expect(late).toMatchObject({ ok: false, error: expect.stringMatching(/start time has passed/) });
    expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
  });

  it("an email's fingerprint is unchanged by this slice (v1)", async () => {
    const { draftFingerprint } = await import("@/lib/dashboard/approval");
    const { sha256 } = await import("@/lib/crypto");
    const d = { id: "drf_1", to: ["a@b.co"], cc: [], subject: "s", body: "b" };
    expect(draftFingerprint(d)).toBe(sha256(JSON.stringify(["v1", "drf_1", ["a@b.co"], [], "s", "b"])));
    expect(draftFingerprint({ ...d, kind: "email" })).toBe(draftFingerprint(d));
  });
});
