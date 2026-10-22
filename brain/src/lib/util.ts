import { randomBytes } from "node:crypto";

/** Time-sortable, URL-safe id: `<prefix>_<base36 ms><8 random hex>`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

/** Stable key for a client/person name so "ACME Corp" and "acme corp " match. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function sameClient(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return slugify(a) === slugify(b);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function toIso(d: Date | number | string): string {
  return new Date(d).toISOString();
}

/** Parses a date-ish string to ISO, or undefined if unparseable. */
export function normalizeDate(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Offset (ms) of `timeZone` from UTC at instant `t`. */
function tzOffsetMs(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Wall-clock time in `timeZone` → UTC epoch ms (DST-aware). */
export function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = naive - tzOffsetMs(naive, timeZone);
  guess = naive - tzOffsetMs(guess, timeZone);
  return guess;
}

/**
 * Parse a date the model or a device gave us, interpreting zone-less values in the OWNER's time
 * zone (not the server's UTC). Date-only values become the start or end of that local day.
 *   "2026-10-23"             -> 23:59 (endOfDay) or 00:00 America/Denver
 *   "2026-10-23T17:00"       -> 17:00 America/Denver
 *   "2026-10-23T17:00-04:00" -> as given
 */
export function normalizeOwnerDate(
  s: string | undefined | null,
  opts: { timeZone: string; dateOnly?: "endOfDay" | "startOfDay" },
): string | undefined {
  if (!s) return undefined;
  const v = s.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, m, d] = dateOnly.map(Number) as [number, number, number, number];
    const end = (opts.dateOnly ?? "endOfDay") === "endOfDay";
    const t = zonedTimeToUtc(y, m, d, end ? 23 : 0, end ? 59 : 0, 0, opts.timeZone);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(v);
  if (naive) {
    const [, y, m, d, h, mi, sec] = naive;
    const t = zonedTimeToUtc(Number(y), Number(m), Number(d), Number(h), Number(mi), Number(sec ?? 0), opts.timeZone);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  return normalizeDate(v);
}

/** YYYY-MM-DD of `d` in `timeZone`. */
export function localDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function daysBetween(fromIso: string, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - Date.parse(fromIso)) / 86_400_000));
}

/** Run `fn` over items with bounded concurrency, preserving order of results. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const IMPORTANCE_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, FYI: 0 } as const;
