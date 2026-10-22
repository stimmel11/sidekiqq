import { config } from "../env";

/** Owner-local date formatting for the dashboard (America/Denver by default). */

export function formatDay(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const tz = config.ownerTimezone();
  const day = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: tz });
  const diff = Math.round((Date.parse(day(d)) - Date.parse(day(now))) / 86_400_000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", ...(Math.abs(diff) > 300 ? { year: "numeric" } : {}) });
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { timeZone: config.ownerTimezone(), month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatLongToday(now: Date = new Date()): string {
  return now.toLocaleDateString("en-US", { timeZone: config.ownerTimezone(), weekday: "long", month: "long", day: "numeric" });
}

/** Brief section titles arrive in caps ("TODAY", "FOLLOW-UP NEEDED"); show them in sentence case. */
export function sentenceCase(s: string): string {
  const lower = s.trim().toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
