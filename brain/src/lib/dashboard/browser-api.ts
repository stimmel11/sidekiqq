/**
 * Dashboard → brain API calls made FROM THE BROWSER as the signed-in session (web app slice
 * 2c-ii-b, docs/WEBAPP.md §4.2). Client-safe: no server imports.
 *
 * The browser posts straight to the device routes, which accept the session through
 * `withPrincipal` (session cookie + fail-closed same-origin check). There is still exactly one
 * send path: `POST /api/drafts/:id/approve`. For a session that route requires
 * `{ "confirmation": draftFingerprint(draft) }`, re-checked against the draft under the send lock,
 * so the fingerprint the confirm dialog was rendered with is the only thing that can authorize a
 * send. `approveDraft` is called only from the dialog's own confirm button.
 */

export type ActionOutcome = { ok: true; warning?: string } | { ok: false; error: string };

/** The subset of `fetch` used here (injectable for tests). */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Same id shape the middleware lets the session cookie reach (`PRINCIPAL_ROUTES`). */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

const CONFIRM_FIRST = "Confirm the draft in the send dialog first. Nothing was sent.";

/** Route error codes whose own message is the one to show (more specific than the status). */
export const CODE_MESSAGES: Record<string, string> = {
  changed: "The draft changed after you opened it. Review it again before sending. Nothing was sent.",
  confirmation_required: CONFIRM_FIRST,
  changed_in_provider: "The draft was changed in Gmail after it was drafted, so nothing was sent. It has been marked discarded; review it in Gmail.",
  no_provider_draft: "This draft has no Gmail draft attached, so it can't be sent from here.",
  unsupported_kind: "This kind of draft can't be approved yet. Nothing was sent.",
  invalid_draft: "This draft can't be sent as stored, so nothing was sent. Ask SideKiqq to prepare it again.",
  provider_refused: "The provider refused it, so nothing was sent. It is still pending; reconnecting the account from Connections may help.",
  expired: "The invite's start time has passed, so nothing was sent. It has been marked discarded; ask SideKiqq for a new invite.",
  not_pending: "This draft is no longer pending. Reload to see what happened to it.",
  in_progress: "This draft is already being sent. Reload in a moment to check.",
  gone: "The Gmail draft was deleted, so nothing was sent. It has been marked discarded.",
  unauthorized: "Your session has expired. Sign in again; nothing was changed.",
  cross_site: "The request was refused by the browser check; nothing was changed. Reload the page and try again.",
};

const APPROVE_STATUS: Record<number, string> = {
  404: "This draft no longer exists.",
  409: "This draft is already being sent or is no longer pending.",
  410: "The Gmail draft was deleted, so nothing was sent. It has been marked discarded.",
  500: "The server reported an error. Check Drafts and Gmail before trying again.",
  503: "Gmail isn't connected or the server isn't configured, so nothing was sent.",
};

/** Turn a route reply into an outcome. Unknown codes fall back to the status, then the route's message. */
export function outcomeFor(status: number, body: Record<string, unknown>, byStatus: Record<number, string> = {}): ActionOutcome {
  if (status >= 200 && status < 300) return typeof body.warning === "string" && body.warning ? { ok: true, warning: body.warning } : { ok: true };
  const byCode = typeof body.code === "string" && Object.hasOwn(CODE_MESSAGES, body.code) ? CODE_MESSAGES[body.code] : undefined;
  const fallback = typeof body.error === "string" && body.error ? body.error : `Request failed (${status}).`;
  const byStat = Object.hasOwn(byStatus, status) ? byStatus[status] : undefined;
  return { ok: false, error: byCode ?? byStat ?? fallback };
}

function defaultFetch(): FetchLike {
  return (input, init) => globalThis.fetch(input, init);
}

async function post(fetchFn: FetchLike, path: string, json: unknown | undefined, byStatus: Record<number, string>, offline: string): Promise<ActionOutcome> {
  let res: Response;
  try {
    res = await fetchFn(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: json === undefined ? {} : { "content-type": "application/json" },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
  } catch {
    return { ok: false, error: offline };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // non-JSON reply; the status is enough
  }
  return outcomeFor(res.status, body, byStatus);
}

/**
 * Approve (send) a draft as the session. `confirmation` is the fingerprint the server rendered
 * into the confirm dialog together with what it showed. Call only from the dialog's confirm button.
 */
export async function approveDraft(id: string, confirmation: string, fetchFn: FetchLike = defaultFetch()): Promise<ActionOutcome> {
  if (!ID.test(id)) return { ok: false, error: "Missing draft id." };
  if (!FINGERPRINT.test(confirmation)) return { ok: false, error: CONFIRM_FIRST };
  return post(
    fetchFn,
    `/api/drafts/${id}/approve`,
    { confirmation },
    APPROVE_STATUS,
    // The request may or may not have reached the server.
    "Couldn't reach SideKiqq, so the result is unknown. Reload Drafts to check before trying again.",
  );
}

export async function discardDraft(id: string, fetchFn: FetchLike = defaultFetch()): Promise<ActionOutcome> {
  if (!ID.test(id)) return { ok: false, error: "Missing draft id." };
  return post(fetchFn, `/api/drafts/${id}/discard`, undefined, { 404: "This draft no longer exists." }, "Couldn't reach SideKiqq. Check your connection and try again.");
}

export async function completeCommitment(id: string, fetchFn: FetchLike = defaultFetch()): Promise<ActionOutcome> {
  if (!ID.test(id)) return { ok: false, error: "Missing commitment id." };
  return post(fetchFn, `/api/commitments/${id}/complete`, undefined, { 404: "That commitment no longer exists." }, "Couldn't reach SideKiqq. Check your connection and try again.");
}
