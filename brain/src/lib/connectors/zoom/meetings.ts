import { z } from "zod";
import type { In, VideoRoom } from "../capabilities";
import type { FetchLike, ZoomAuth } from "./auth";
import { ZoomApiError } from "./errors";

/**
 * THE ONLY place that creates Zoom meetings (docs/CONNECTORS.md §6; enforced by test/no-send.test.ts).
 *
 * `video.create_room` is `auto` because the room is unannounced: the request body below is fixed
 * in code. It has no `meeting_invitees`, no `alternative_hosts`, no `schedule_for`, no registration
 * (approval_type 2 = none) and every Zoom email notification turned off, so creating a room emails
 * no one. Only `topic`, `start` and `duration` come from the caller, and those are validated by
 * `VideoCreateRoomInput` before this runs. Inviting people is `calendar.invite.prepare` (confirm),
 * a later slice, and goes through draft approval.
 *
 * The host `start_url` (it embeds a host token) is never returned, logged or stored.
 *
 * Zoom for Government (zoomgov.com) is not supported: both the API base and the join-link check
 * are zoom.us only.
 */

const ZOOM_API = "https://api.zoom.us/v2";
const TIMEOUT_MS = 10_000;
export const DEFAULT_ROOM_MINUTES = 30;

/** The complete request body. Exported for the test that pins it. */
export function roomRequestBody(input: In<"video.create_room">) {
  const scheduled = input.start !== undefined;
  return {
    topic: input.topic,
    // 1 = instant, 2 = scheduled.
    type: scheduled ? 2 : 1,
    ...(scheduled ? { start_time: new Date(input.start!).toISOString().replace(/\.\d{3}Z$/, "Z"), timezone: "UTC" } : {}),
    duration: input.durationMin ?? DEFAULT_ROOM_MINUTES,
    settings: {
      join_before_host: false,
      waiting_room: true,
      approval_type: 2,
      registrants_email_notification: false,
      registrants_confirmation_email: false,
      alternative_hosts: "",
      alternative_hosts_email_notification: false,
      email_notification: false,
      auto_recording: "none",
      // AI Companion can email meeting summaries to participants/invitees; keep it off. Settings the
      // owner's account LOCKS on can't be overridden here: check them when connecting Zoom.
      auto_start_meeting_summary: false,
      auto_start_ai_companion_questions: false,
      push_change_to_calendar: false,
      continuous_meeting_chat: { enable: false },
    },
  } as const;
}

const ZoomMeetingResponse = z.object({
  id: z.union([z.number(), z.string()]),
  join_url: z.string(),
  password: z.string().optional(),
  start_time: z.string().optional(),
});

/** https, no credentials or port, host zoom.us or a subdomain (e.g. us02web.zoom.us). */
export function isZoomJoinUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return u.protocol === "https:" && !u.username && !u.password && !u.port && (host === "zoom.us" || host.endsWith(".zoom.us"));
}

export interface ZoomRooms {
  create(input: In<"video.create_room">): Promise<VideoRoom>;
}

export class ZoomMeetings implements ZoomRooms {
  constructor(
    private readonly auth: Pick<ZoomAuth, "accessToken" | "invalidate">,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async create(input: In<"video.create_room">): Promise<VideoRoom> {
    const body = JSON.stringify(roomRequestBody(input));
    // One retry with a fresh token if Zoom says the access token is no longer valid. Never retried
    // otherwise: a timeout may still have created the room, and a duplicate room is worse.
    let res = await this.post(await this.auth.accessToken(), body);
    if (res.status === 401) {
      this.auth.invalidate();
      res = await this.post(await this.auth.accessToken(), body);
    }
    if (!res.ok) {
      const msg =
        res.status === 429
          ? "Zoom is rate-limiting requests right now; try again in a minute."
          : res.status === 401 || res.status === 403
            ? "Zoom refused to create the room (permission denied). The owner may need to reconnect Zoom."
            : `Zoom could not create the room (HTTP ${res.status}).`;
      throw new ZoomApiError(res.status, msg);
    }
    const parsed = ZoomMeetingResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ZoomApiError(502, "Zoom returned an unexpected response.");
    const m = parsed.data;
    if (!isZoomJoinUrl(m.join_url)) throw new ZoomApiError(502, "Zoom returned a join link that isn't on zoom.us.");
    return {
      meetingId: String(m.id),
      joinUrl: m.join_url,
      ...(m.password ? { passcode: m.password } : {}),
      ...(input.start !== undefined && m.start_time ? { start: m.start_time } : {}),
    };
  }

  private async post(token: string, body: string): Promise<Response> {
    try {
      return await this.send(token, body);
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ZoomApiError(504, "Zoom didn't answer in time. The room may still have been created: check the Zoom app before asking again.");
      }
      throw err;
    }
  }

  private send(token: string, body: string): Promise<Response> {
    return this.fetchFn(`${ZOOM_API}/users/me/meetings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}
