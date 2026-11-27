import { sha256 } from "./crypto";
import type { Draft } from "./models";

/**
 * Fingerprint of exactly what a confirm dialog showed for a draft (docs/WEBAPP.md §4.2).
 *
 * The dashboard renders it into the send dialog (the browser posts it back as
 * `{ confirmation }`), and the approve route recomputes it for session principals from the
 * stored draft and refuses to send on any mismatch, so a stale page or a draft that changed
 * after the dialog opened is never sent.
 */
export function draftFingerprint(d: Pick<Draft, "id" | "to" | "cc" | "subject" | "body"> & Partial<Pick<Draft, "kind" | "when" | "location" | "conference">>): string {
  const kind = d.kind ?? "email";
  if (kind === "email") return sha256(JSON.stringify(["v1", d.id, d.to, d.cc ?? [], d.subject, d.body]));
  // Calendar kinds: what the dialog shows also includes the time, the place and the video link.
  return sha256(JSON.stringify(["v2", kind, d.id, d.to, d.cc ?? [], d.subject, d.body, d.when ?? null, d.location ?? null, d.conference ?? null]));
}
