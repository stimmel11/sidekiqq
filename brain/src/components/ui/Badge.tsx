import type { Importance } from "@/lib/models";
import { cx } from "./cx";

/** Importance mapping from design/tokens.json: CRITICAL = Alert, HIGH = Signal, MEDIUM = Slate, LOW/FYI = muted Slate. */
export const IMPORTANCE_STYLE: Record<Importance, { badge: string; rule: string; label: string }> = {
  CRITICAL: { badge: "bg-imp-critical-bg text-imp-critical-fg", rule: "bg-imp-critical-rule", label: "Critical" },
  HIGH: { badge: "bg-imp-high-bg text-imp-high-fg", rule: "bg-imp-high-rule", label: "High" },
  MEDIUM: { badge: "bg-imp-medium-bg text-imp-medium-fg", rule: "bg-imp-medium-rule", label: "Medium" },
  LOW: { badge: "bg-imp-low-bg text-imp-low-fg", rule: "bg-imp-low-rule", label: "Low" },
  FYI: { badge: "bg-imp-fyi-bg text-imp-fyi-fg", rule: "bg-imp-fyi-rule", label: "FYI" },
};

type Tone = "neutral" | "success" | "danger" | "accent";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-text-muted",
  success: "bg-surface-sunken text-success-ink",
  danger: "bg-imp-critical-bg text-imp-critical-fg",
  accent: "bg-imp-high-bg text-imp-high-fg",
};

const shape = "inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono text-data";

/** Importance badge. Color is never the only signal: the level is always written out. */
export function Badge({ importance, className }: { importance: Importance; className?: string }) {
  const s = IMPORTANCE_STYLE[importance];
  return (
    <span className={cx(shape, s.badge, className)}>
      <span aria-hidden className={cx("h-1.5 w-1.5 rounded-pill", s.rule)} />
      {s.label}
      <span className="sr-only"> importance</span>
    </span>
  );
}

export function Tag({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cx(shape, TONES[tone], className)}>{children}</span>;
}
