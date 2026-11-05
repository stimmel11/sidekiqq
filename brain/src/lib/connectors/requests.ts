import { HttpError } from "../http";
import type { ConnectorRequestStatus } from "../models";

/**
 * "Request a connector" helpers (docs/CONNECTOR_REQUESTS.md). Logging a request never builds,
 * connects or enables anything; it only records what the owner asked for.
 */

/** Normalise a spoken service name for de-duplication: "King Soopers", "king-soopers." → "kingsoopers". */
export function serviceKey(service: string): string {
  return service
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Services the brain already supports through a built-in connector. Keys are `serviceKey` output. */
const BUILT_IN: Record<string, string> = {
  google: "Google (Gmail, Calendar, Drive and Contacts)",
  gmail: "Gmail",
  googlemail: "Gmail",
  googlecalendar: "Google Calendar",
  gcal: "Google Calendar",
  googledrive: "Google Drive",
  gdrive: "Google Drive",
  googledocs: "Google Drive",
  googlesheets: "Google Drive",
  googleslides: "Google Drive",
  googlecontacts: "Google Contacts",
};

/** The built-in connector that already covers this service, if any. */
export function builtInFor(service: string): string | undefined {
  return BUILT_IN[serviceKey(service)];
}

/**
 * Allowed status changes. Only the owner changes status, but the crew builds only `accepted`
 * requests, so a request can't skip acceptance on its way to building/review/live.
 */
export const CONNECTOR_REQUEST_TRANSITIONS: Record<ConnectorRequestStatus, readonly ConnectorRequestStatus[]> = {
  new: ["accepted", "declined"],
  accepted: ["building", "in_review", "declined", "new"],
  building: ["in_review", "accepted", "declined"],
  in_review: ["live", "building", "declined"],
  live: ["accepted"],
  declined: ["new", "accepted"],
};

/** Open requests kept at once; past this the owner should decline or finish some first. */
export const MAX_OPEN_CONNECTOR_REQUESTS = 50;

export type ConnectorRequestErrorCode = "not_found" | "too_many_open" | "needs_pr_url" | "already_open" | "bad_transition" | "invalid";

/** An HttpError, so owner routes return it as-is. */
export class ConnectorRequestError extends HttpError {
  constructor(message: string, readonly reason: ConnectorRequestErrorCode, status: number) {
    super(status, message, reason);
    this.name = "ConnectorRequestError";
  }
}
