import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { executeTool, type ToolContext } from "@/lib/assistant/tools";
import { KnownAddresses } from "@/lib/assistant/recipients";
import { prepareCalendarInvite } from "@/lib/connectors/prepare";
import { inviteEventId, zoomJoinText, zoomRoomMinutes } from "@/lib/connectors/google/send";
import { buildReadback } from "@/lib/connectors/readback";
import { CapabilityDeniedError } from "@/lib/connectors/types";
import { ZOOM_MEETING_SCOPE } from "@/lib/connectors/zoom/auth";
import { ZoomApiError } from "@/lib/connectors/zoom/errors";
import { DraftSchema, type Action } from "@/lib/models";
import { makeDeps, pairDevice, params, req, type TestDeps } from "./fakes";
import { POST as approve } from "@/app/api/drafts/[id]/approve/route";
import { GET as listDrafts } from "@/app/api/drafts/route";

/**
 * Meet + Zoom in invites, slice 2 (Zoom): `conference: "zoom"` on `calendar.invite.prepare` makes
 * only a pending Draft (no room). The Zoom room is made at approve time, through
 * invokeCapability("video.create_room"), saved on the draft before the event write, and its join
 * link goes into the event. Any Zoom failure means no event and nothing sent.
 */

const NOW = new Date("2026-11-02T15:00:00Z");
const G = "https://www.googleapis.com/auth/";
const GOOGLE_SCOPES = [`${G}gmail.readonly`, `${G}gmail.compose`, `${G}calendar.readonly`, `${G}calendar.events`, `${G}drive.readonly`, `${G}contacts.readonly`, `${G}contacts.other.readonly`];

const invite = (over: Record<string, unknown> = {}) => ({
  title: "Kickoff",
  start: "2026-11-03T21:00:00.000Z",
  end: "2026-11-03T21:45:00.000Z",
  attendees: ["dana@acme.com"],
  conference: "zoom",
  ...over,
});

async function connectZoom(deps: TestDeps, over: { enabled?: string[] } = {}) {
  await deps.connections.save("zoom", {
    secret: "zoom-rt",
    secretKind: "refresh_token",
    grantedScopes: [ZOOM_MEETING_SCOPE],
    connectedAt: "2026-10-01T00:00:00.000Z",
    ...(over.enabled ? { enabled: over.enabled as never } : {}),
  });
}

async function setup(opts: { zoom?: boolean; zoomConnected?: boolean } = {}) {
  const deps = makeDeps({ now: NOW, zoom: opts.zoom ?? true });
  setDeps(deps);
  await deps.connections.save("google", { secret: "refresh-SECRET", secretKind: "refresh_token", grantedScopes: GOOGLE_SCOPES, connectedAt: "2026-10-01T00:00:00.000Z" });
  if (opts.zoomConnected ?? true) await connectZoom(deps);
  const { token } = await pairDevice(deps, "phone");
  return { deps, token };
}

describe("preparing a Zoom invite", () => {
  it("makes one pending Draft that says Zoom, and makes no room", async () => {
    const { deps } = await setup();
    const out = await prepareCalendarInvite(deps, invite(), { caller: "ask", device: "phone" });
    expect(out.readback).toBe("Calendar invite to dana@acme.com, Tue Nov 3 2–2:45 pm, with a Zoom link, with the title: Kickoff.");
    expect(await deps.repos.drafts.get(out.draftId)).toMatchObject({ kind: "calendar_invite", conference: "zoom", status: "pending" });
    expect((await deps.repos.drafts.get(out.draftId))!.videoRoom).toBeUndefined();
    expect(deps.zoom.created).toEqual([]);
    expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
  });

  it("is refused (no Draft) when Zoom isn't set up, isn't connected, needs reauth, or rooms are switched off", async () => {
    const cases: [string, (d: TestDeps) => Promise<void>, { zoom?: boolean; zoomConnected?: boolean }][] = [
      ["not set up", async () => undefined, { zoom: false }],
      ["not connected", async () => undefined, { zoomConnected: false }],
      ["needs reauth", async (d) => void (await d.connections.markNeedsReauth("zoom", "x", "zoom-rt")), {}],
      ["switched off", async (d) => connectZoom(d, { enabled: [] }), {}],
    ];
    for (const [name, arrange, opts] of cases) {
      const { deps } = await setup(opts);
      await arrange(deps);
      await expect(prepareCalendarInvite(deps, invite(), { caller: "ask" }), name).rejects.toBeInstanceOf(CapabilityDeniedError);
      expect(await deps.repos.drafts.listPending(), name).toEqual([]);
      const [row] = await deps.repos.audit.recent();
      expect(row, name).toMatchObject({ capability: "calendar.invite.prepare", ok: false });
    }
  });

  it("a Meet invite doesn't need Zoom", async () => {
    const { deps } = await setup({ zoom: false });
    await expect(prepareCalendarInvite(deps, invite({ conference: "meet" }), { caller: "ask" })).resolves.toHaveProperty("draftId");
  });

  it("the create_calendar_invite tool accepts conference zoom", async () => {
    const { deps } = await setup();
    const known = new KnownAddresses();
    known.addText("Zoom with dana@acme.com tomorrow at 2");
    const ctx: ToolContext & { actions: Action[] } = { deps, now: deps.clock(), device: "phone", actions: [], knownAddresses: known };
    await executeTool("create_calendar_invite", { title: "Kickoff", start: "2026-11-03T14:00", attendees: ["dana@acme.com"], conference: "zoom" }, ctx);
    expect(ctx.actions[0]).toMatchObject({ type: "draft_created", draftKind: "calendar_invite" });
    expect(ctx.actions[0]!.summary).toMatch(/with a Zoom link/);
    expect(deps.zoom.created).toEqual([]);
  });

  it("GET /api/drafts lists conference zoom and never the stored room", async () => {
    const { deps, token } = await setup();
    const out = await prepareCalendarInvite(deps, invite(), { caller: "ask" });
    await deps.repos.drafts.setVideoRoom(out.draftId, { provider: "zoom", meetingId: "1", joinUrl: "https://zoom.us/j/1" });
    const res = await listDrafts(req("GET", "/api/drafts", { token }), params({}));
    const { items } = (await res.json()) as { items: Record<string, unknown>[] };
    expect(items[0]).toMatchObject({ conference: "zoom" });
    expect(JSON.stringify(items)).not.toContain("zoom.us/j");
  });
});

describe("approving a Zoom invite", () => {
  it("makes the room through video.create_room, saves it, then writes the event with the join link", async () => {
    const { deps, token } = await setup();
    const out = await prepareCalendarInvite(deps, invite({ body: "Agenda" }), { caller: "ask" });
    const res = await approve(req("POST", "/x", { token }), params({ id: out.draftId }));
    expect(res.status).toBe(200);
    expect(deps.zoom.created).toEqual([{ topic: "Kickoff", start: "2026-11-03T21:00:00.000Z", durationMin: 45 }]);
    const join = "https://us02web.zoom.us/j/8100000001?pwd=abc";
    expect(deps.inviter.insertInvite).toHaveBeenCalledWith({
      eventId: inviteEventId(out.draftId),
      title: "Kickoff",
      description: `Agenda\n\nJoin Zoom meeting: ${join}\nMeeting ID: 8100000001\nPasscode: 123456`,
      location: join,
      start: "2026-11-03T21:00:00.000Z",
      end: "2026-11-03T21:45:00.000Z",
      attendees: ["dana@acme.com"],
      meet: false,
      requestId: out.draftId,
    });
    expect(await deps.repos.drafts.get(out.draftId)).toMatchObject({ status: "sent", videoRoom: { provider: "zoom", meetingId: "8100000001", joinUrl: join } });
    const rows = await deps.repos.audit.recent();
    expect(rows.find((r) => r.capability === "video.create_room")).toMatchObject({ connector: "zoom", caller: "task", ok: true });
  });

  it("keeps the owner's location; the link is still in the description", async () => {
    const { deps, token } = await setup();
    const out = await prepareCalendarInvite(deps, invite({ location: "Room 4" }), { caller: "ask" });
    expect((await approve(req("POST", "/x", { token }), params({ id: out.draftId }))).status).toBe(200);
    const e = deps.inviter.insertInvite.mock.calls[0]![0];
    expect(e.location).toBe("Room 4");
    expect(e.description).toMatch(/^Join Zoom meeting: https:\/\/us02web\.zoom\.us\//);
  });

  it("a Google failure after the room was made: the retry reuses the saved room (one room, one event id)", async () => {
    const { deps, token } = await setup();
    const out = await prepareCalendarInvite(deps, invite(), { caller: "ask" });
    deps.inviter.error = new Error("backend error");
    expect((await approve(req("POST", "/x", { token }), params({ id: out.draftId }))).status).toBe(500);
    expect((await deps.repos.drafts.get(out.draftId))).toMatchObject({ status: "pending", videoRoom: { meetingId: "8100000001" } });
    deps.inviter.error = null;
    expect((await approve(req("POST", "/x", { token }), params({ id: out.draftId }))).status).toBe(200);
    expect(deps.zoom.created).toHaveLength(1);
    const calls = deps.inviter.insertInvite.mock.calls.map((c) => c[0]);
    expect(new Set(calls.map((c) => c.eventId))).toEqual(new Set([inviteEventId(out.draftId)]));
    expect(calls.every((c) => c.location === "https://us02web.zoom.us/j/8100000001?pwd=abc")).toBe(true);
  });

  it("a Zoom failure is a definite not-sent: 422 provider_refused, no event, still pending", async () => {
    const errors: [Error, RegExp][] = [
      [new ZoomApiError(429, "Zoom is rate-limiting requests right now; try again in a minute."), /rate-limiting.*not sent/],
      [new ZoomApiError(504, "Zoom didn't answer in time. The room may still have been created: check the Zoom app before asking again."), /in time/],
      [new Error("socket hang up"), /couldn't make the Zoom room/],
    ];
    for (const [err, message] of errors) {
      const { deps, token } = await setup();
      const out = await prepareCalendarInvite(deps, invite(), { caller: "ask" });
      deps.zoom.error = err;
      const res = await approve(req("POST", "/x", { token }), params({ id: out.draftId }));
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("provider_refused");
      expect(JSON.stringify(body)).toMatch(message);
      expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
      expect(await deps.repos.drafts.get(out.draftId)).toMatchObject({ status: "pending" });
      expect((await deps.repos.drafts.get(out.draftId))!.videoRoom).toBeUndefined();
    }
  });

  it("Zoom disconnected or switched off after prepare: refused at approve, nothing written", async () => {
    for (const arrange of [
      async (d: TestDeps) => void (await d.connections.markNeedsReauth("zoom", "x", "zoom-rt")),
      async (d: TestDeps) => connectZoom(d, { enabled: [] }),
    ]) {
      const { deps, token } = await setup();
      const out = await prepareCalendarInvite(deps, invite(), { caller: "ask" });
      await arrange(deps);
      const res = await approve(req("POST", "/x", { token }), params({ id: out.draftId }));
      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).toMatch(/Zoom (needs to be reconnected|rooms are turned off).*not sent/);
      expect(deps.zoom.created).toEqual([]);
      expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
    }
  });

  it("Zoom unregistered after prepare (ZOOM_CLIENT_ID removed): refused at approve", async () => {
    const { deps, token } = await setup({ zoom: false });
    // As if prepared while Zoom was still configured.
    const d = await deps.repos.drafts.create({ kind: "calendar_invite", to: ["dana@acme.com"], subject: "Kickoff", body: "", conference: "zoom", when: { start: "2026-11-03T21:00:00.000Z", end: "2026-11-03T21:30:00.000Z" } });
    const res = await approve(req("POST", "/x", { token }), params({ id: d.id }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/isn't set up/);
    expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(d.id))?.status).toBe("pending");
  });

  it("a Meet invite never makes a Zoom room", async () => {
    const { deps, token } = await setup();
    const out = await prepareCalendarInvite(deps, invite({ conference: "meet" }), { caller: "ask" });
    expect((await approve(req("POST", "/x", { token }), params({ id: out.draftId }))).status).toBe(200);
    expect(deps.zoom.created).toEqual([]);
    expect(deps.inviter.insertInvite.mock.calls[0]![0]).toMatchObject({ meet: true });
  });
});

describe("Zoom invite helpers and the record", () => {
  it("room length follows the event, within video.create_room's 5–240 minutes", () => {
    expect(zoomRoomMinutes({ start: "2026-11-03T21:00:00Z", end: "2026-11-03T21:30:00Z" })).toBe(30);
    expect(zoomRoomMinutes({ start: "2026-11-03T21:00:00Z", end: "2026-11-03T21:02:00Z" })).toBe(5);
    expect(zoomRoomMinutes({ start: "2026-11-03T21:00:00Z", end: "2026-11-04T05:00:00Z" })).toBe(240);
  });

  it("join text has only the link, id and passcode", () => {
    expect(zoomJoinText({ provider: "zoom", meetingId: "1", joinUrl: "https://zoom.us/j/1" })).toBe("Join Zoom meeting: https://zoom.us/j/1\nMeeting ID: 1");
  });

  it("readback for zoom; the record refuses a room on anything but a Zoom invite", () => {
    expect(buildReadback({ kind: "calendar_invite", to: ["a@b.co"], subject: "x", when: { start: "2026-11-03T21:00:00Z", end: "2026-11-03T22:00:00Z" }, conference: "zoom" }, "America/Denver")).toMatch(/with a Zoom link/);
    const base = { id: "drf_1", status: "pending", createdAt: "2026-11-02T15:00:00.000Z", kind: "calendar_invite", to: ["a@b.co"], subject: "x", body: "", readback: "r", when: { start: "2026-11-03T21:00:00Z", end: "2026-11-03T22:00:00Z" } };
    const room = { provider: "zoom", meetingId: "1", joinUrl: "https://zoom.us/j/1" };
    expect(DraftSchema.safeParse({ ...base, conference: "zoom", videoRoom: room }).success).toBe(true);
    expect(DraftSchema.safeParse({ ...base, conference: "meet", videoRoom: room }).success).toBe(false);
    expect(DraftSchema.safeParse({ ...base, kind: "email", when: undefined, videoRoom: room }).success).toBe(false);
  });

  it("setVideoRoom writes once, only on a pending Zoom invite", async () => {
    const { deps } = await setup();
    const room = { provider: "zoom" as const, meetingId: "1", joinUrl: "https://zoom.us/j/1" };
    const z = await prepareCalendarInvite(deps, invite(), { caller: "ask" });
    const m = await prepareCalendarInvite(deps, invite({ conference: "meet" }), { caller: "ask" });
    expect(await deps.repos.drafts.setVideoRoom(m.draftId, room)).toBe(false);
    expect(await deps.repos.drafts.setVideoRoom(z.draftId, room)).toBe(true);
    expect(await deps.repos.drafts.setVideoRoom(z.draftId, { ...room, meetingId: "2" })).toBe(false);
    expect((await deps.repos.drafts.get(z.draftId))!.videoRoom?.meetingId).toBe("1");
    await deps.repos.drafts.markSent(z.draftId, "e");
    const z2 = await prepareCalendarInvite(deps, invite(), { caller: "ask" });
    await deps.repos.drafts.markDiscarded(z2.draftId);
    expect(await deps.repos.drafts.setVideoRoom(z2.draftId, room)).toBe(false);
  });
});
