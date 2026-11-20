/**
 * Browser side of web hand-offs (docs/WEBAPP.md §7). Client-safe: imported by the dashboard's
 * HandoffCards component. Reads `GET /api/commands` and posts `POST /api/commands/:id/ack` as the
 * signed-in session (same-origin cookie, no bearer token). Nothing here opens a link: the owner
 * taps the link the card shows, and only that tap acks `opened`.
 */
import type { CommandResult } from "@/lib/models";

export const POLL_MS = 15_000;

/** The fields a card uses. Anything else in the reply is ignored. */
export interface HandoffItem {
  id: string;
  kind: string;
  label: string;
  expiresAt: string;
  url?: string;
  number?: string;
  name?: string;
  app?: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const str = (v: unknown): v is string => typeof v === "string";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HandoffsResult = { ok: true; items: HandoffItem[] } | { ok: false; status: number };

/** Read this browser's pending hand-offs. Malformed rows are dropped, not shown. */
export async function fetchHandoffs(fetchImpl: FetchLike = fetch): Promise<HandoffsResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/commands?limit=20", { method: "GET", credentials: "same-origin", cache: "no-store" });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!res.ok) return { ok: false, status: res.status };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, status: res.status };
  }
  const raw = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) return { ok: false, status: res.status };
  const items: HandoffItem[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || !str(r.id) || !ID.test(r.id) || !str(r.kind) || !str(r.label) || !str(r.expiresAt)) continue;
    items.push({
      id: r.id,
      kind: r.kind,
      label: r.label,
      expiresAt: r.expiresAt,
      ...(str(r.url) ? { url: r.url } : {}),
      ...(str(r.number) ? { number: r.number } : {}),
      ...(str(r.name) ? { name: r.name } : {}),
      ...(str(r.app) ? { app: r.app } : {}),
    });
  }
  return { ok: true, items };
}

/**
 * Report what the owner did with a hand-off. `keepalive` so an `opened` ack still goes out when the
 * tap navigates away (tel:, or a link the browser opens in this tab). Never throws.
 */
export async function ackHandoff(id: string, result: CommandResult, fetchImpl: FetchLike = fetch): Promise<boolean> {
  if (!ID.test(id)) return false;
  try {
    const res = await fetchImpl(`/api/commands/${id}/ack`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result }),
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}
