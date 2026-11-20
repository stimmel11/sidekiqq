/**
 * Client-safe hand-off link rules (docs/WEBAPP.md §7). Imported by the brain (lib/commands) and by
 * the browser (components/handoffs), so it must not import server-only modules.
 *
 * The browser re-checks every field before it builds a link, and builds the link only from the
 * structured fields (`url`, `number`, `app`), never from `label`. A command that fails a check gets
 * no link at all. Nothing here opens anything: the owner taps the link.
 */

/**
 * `open_url` host allowlist (CONNECTORS.md §2 `device.open_url`): meeting join links and grocery
 * cart pages only. Exact hosts, plus registrable domains whose subdomains are allowed.
 */
export const OPEN_URL_HOSTS: readonly string[] = ["meet.google.com", "www.kroger.com", "www.kingsoopers.com"];
export const OPEN_URL_DOMAINS: readonly string[] = ["zoom.us"];

export function isAllowedOpenUrlHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return OPEN_URL_HOSTS.includes(host) || OPEN_URL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Allowed number characters (no `* # , ;`: dialer MMI/USSD codes and post-dial digits). */
const NUMBER_CHARS = /^\+?[0-9 ().-]+$/;

/** The stored number shape the brain writes: digits with an optional leading "+", 3–15 digits. */
const STORED_NUMBER = /^\+?[0-9]{3,15}$/;

/** What a hand-off card shows and links to. `href` is null when the command fails a check. */
export type HandoffLink =
  | { ok: true; href: string; /** the number or host, shown on its own line */ detail: string; external: boolean; action: "Call" | "Open" }
  | { ok: false; reason: string };

type LinkFields = { kind: string; url?: string | undefined; number?: string | undefined; app?: string | undefined };

/** Re-check a number for a `tel:` / `wa.me` link. Returns the canonical form (`+` and digits) or null. */
export function checkNumber(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!NUMBER_CHARS.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 15) return null;
  const canonical = (s.startsWith("+") ? "+" : "") + digits;
  return STORED_NUMBER.test(canonical) ? canonical : null;
}

/** Re-check an `open_url` link: https, no credentials or port, allowlisted host. Returns the href or null. */
export function checkOpenUrl(raw: string | undefined): URL | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  return isAllowedOpenUrlHost(u.hostname) ? u : null;
}

/**
 * Build the link a browser hand-off card shows. Only `open_url` and `call_contact` run in a
 * browser; every other kind (and any failed check) gets `{ ok: false }`.
 */
export function handoffLink(cmd: LinkFields): HandoffLink {
  if (cmd.kind === "open_url") {
    const u = checkOpenUrl(cmd.url);
    if (!u) return { ok: false, reason: "bad_url" };
    return { ok: true, href: u.href, detail: u.hostname.toLowerCase(), external: true, action: "Open" };
  }
  if (cmd.kind === "call_contact") {
    const number = checkNumber(cmd.number);
    if (!number) return { ok: false, reason: "bad_number" };
    const app = cmd.app ?? "phone";
    if (app === "whatsapp") {
      if (!number.startsWith("+")) return { ok: false, reason: "bad_number" };
      return { ok: true, href: `https://wa.me/${number.slice(1)}`, detail: number, external: true, action: "Call" };
    }
    if (app !== "phone") return { ok: false, reason: "bad_app" };
    return { ok: true, href: `tel:${number}`, detail: number, external: false, action: "Call" };
  }
  return { ok: false, reason: "unsupported_kind" };
}
