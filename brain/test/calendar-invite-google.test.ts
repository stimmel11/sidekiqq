import { beforeEach, describe, expect, it, vi } from "vitest";

/** The real GoogleCalendarInviter against a mocked googleapis: the exact request it sends. */

const insert = vi.fn();
vi.mock("googleapis", () => ({ google: { calendar: () => ({ events: { insert } }), gmail: () => ({}) } }));

// test/setup.ts already loaded send.ts with the real googleapis; reload it against the mock.
vi.resetModules();
const { GoogleCalendarInviter } = await import("@/lib/connectors/google/send");

const event = {
  eventId: "skqabc123",
  title: "Kickoff",
  description: "Agenda",
  location: "Room 4",
  start: "2026-11-03T21:00:00.000Z",
  end: "2026-11-03T21:30:00.000Z",
  attendees: ["dana@acme.com", "lee@acme.com"],
  meet: true,
  requestId: "drf_1",
};

beforeEach(() => insert.mockReset());

describe("GoogleCalendarInviter", () => {
  it("inserts on the primary calendar with the draft's fields, a Meet request, and notifies attendees", async () => {
    insert.mockResolvedValue({ data: { id: "skqabc123", hangoutLink: "https://meet.google.com/abc-defg-hij" } });
    const out = await new GoogleCalendarInviter({} as never).insertInvite(event);
    expect(out).toEqual({ eventId: "skqabc123", alreadyExisted: false, meetLink: true });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]![0]).toEqual({
      calendarId: "primary",
      sendUpdates: "all",
      conferenceDataVersion: 1,
      requestBody: {
        id: "skqabc123",
        summary: "Kickoff",
        description: "Agenda",
        location: "Room 4",
        start: { dateTime: "2026-11-03T21:00:00.000Z" },
        end: { dateTime: "2026-11-03T21:30:00.000Z" },
        attendees: [{ email: "dana@acme.com" }, { email: "lee@acme.com" }],
        guestsCanInviteOthers: false,
        conferenceData: { createRequest: { requestId: "drf_1", conferenceSolutionKey: { type: "hangoutsMeet" } } },
      },
    });
  });

  it("no Meet: no conferenceData and conferenceDataVersion 0", async () => {
    insert.mockResolvedValue({ data: { id: "skqabc123" } });
    await new GoogleCalendarInviter({} as never).insertInvite({ ...event, meet: false, description: undefined, location: undefined } as never);
    const p = insert.mock.calls[0]![0] as { conferenceDataVersion: number; requestBody: Record<string, unknown> };
    expect(p.conferenceDataVersion).toBe(0);
    expect(p.requestBody).not.toHaveProperty("conferenceData");
    expect(p.requestBody).not.toHaveProperty("description");
    expect(p.requestBody).not.toHaveProperty("location");
  });

  it("409 (this event id already exists) means an earlier approve created it; other errors throw", async () => {
    insert.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: 409 }));
    await expect(new GoogleCalendarInviter({} as never).insertInvite(event)).resolves.toEqual({ eventId: "skqabc123", alreadyExisted: true });
    insert.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { status: 409 })); // gaxios 7+
    await expect(new GoogleCalendarInviter({} as never).insertInvite(event)).resolves.toMatchObject({ alreadyExisted: true });
    insert.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { status: 403 }));
    await expect(new GoogleCalendarInviter({} as never).insertInvite(event)).rejects.toMatchObject({ name: "ProviderRefusedError" });
    insert.mockRejectedValueOnce(Object.assign(new Error("backend"), { status: 503 }));
    await expect(new GoogleCalendarInviter({} as never).insertInvite(event)).rejects.toThrow("backend");
    insert.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(new GoogleCalendarInviter({} as never).insertInvite(event)).rejects.toThrow("socket hang up");
  });

  it("Meet asked for but not created: reported, not hidden", async () => {
    insert.mockResolvedValue({ data: { id: "skqabc123", conferenceData: { createRequest: { status: { statusCode: "failure" } } } } });
    await expect(new GoogleCalendarInviter({} as never).insertInvite(event)).resolves.toEqual({ eventId: "skqabc123", alreadyExisted: false, meetLink: false });
  });
});
