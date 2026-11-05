import { CONNECT_RESULT_TEXT, isConnectResultCode } from "../connectors/oauth";
import type { Connection, ConnectionStatus } from "../connectors/manage";

/** Presentation rules for the dashboard Connections screen (pure, so they are unit-tested). */

export const STATUS_PRESENTATION: Record<ConnectionStatus, { label: string; tone: "success" | "danger" | "neutral" | "accent" }> = {
  connected: { label: "connected", tone: "success" },
  needs_reauth: { label: "needs reconnect", tone: "danger" },
  error: { label: "needs reconnect", tone: "danger" },
  disabled: { label: "everything turned off", tone: "neutral" },
  not_connected: { label: "not connected", tone: "neutral" },
};

/** Which buttons a connection row shows. */
export function connectionActions(c: Pick<Connection, "status">): { connect?: "Connect" | "Reconnect"; connectPrimary: boolean; disconnect: boolean; toggles: boolean } {
  switch (c.status) {
    case "not_connected":
      return { connect: "Connect", connectPrimary: true, disconnect: false, toggles: false };
    case "needs_reauth":
      return { connect: "Reconnect", connectPrimary: true, disconnect: true, toggles: false };
    case "error":
      // The stored record can't be read: reconnecting overwrites it, disconnecting deletes it.
      return { connect: "Reconnect", connectPrimary: true, disconnect: true, toggles: false };
    default:
      return { connect: "Reconnect", connectPrimary: false, disconnect: true, toggles: true };
  }
}

const DONE: Record<string, string> = {
  saved: "Saved. The change applies to the next request.",
  disconnected: "Disconnected. Access was revoked at the provider and the stored sign-in was deleted.",
  disconnected_local: "Disconnected here and the stored sign-in was deleted. The provider didn't confirm the revoke, so also remove SideKiqq from your account's security settings.",
};

const ERRORS: Record<string, string> = {
  connect: "Couldn't start the sign-in. Check the server's OAuth settings and try again.",
  save: "Couldn't save that change. Reload and try again.",
  not_connected: "That service isn't connected any more. Connect it first.",
  unknown: "That service or capability isn't available here.",
};

/** The one status line to show after an action or a provider redirect, if any. */
export function connectionsNotice(q: { done?: string; error?: string; connect?: string }): { tone: "success" | "danger"; text: string } | null {
  if (q.connect && isConnectResultCode(q.connect)) {
    const t = CONNECT_RESULT_TEXT[q.connect];
    return { tone: q.connect === "connected" ? "success" : "danger", text: t.message };
  }
  if (q.error && ERRORS[q.error]) return { tone: "danger", text: ERRORS[q.error]! };
  if (q.done && DONE[q.done]) return { tone: "success", text: DONE[q.done]! };
  return null;
}
