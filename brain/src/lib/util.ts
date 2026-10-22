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
