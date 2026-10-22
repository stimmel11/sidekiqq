import type { ReactNode } from "react";
import type { Importance } from "@/lib/models";
import { IMPORTANCE_STYLE } from "./Badge";
import { cx } from "./cx";

type Props = {
  title: ReactNode;
  /** Secondary line(s) under the title. */
  detail?: ReactNode;
  /** Small data line: dates, counts, ids (mono). */
  meta?: ReactNode;
  /** Badges next to the title. */
  badges?: ReactNode;
  /** Actions on the right (wraps below on narrow screens). */
  actions?: ReactNode;
  /** Draws an importance rule down the left edge. */
  importance?: Importance;
  className?: string;
  children?: ReactNode;
};

/** One item in a list. Use inside <ul className="divide-y divide-line">. */
export function ListRow({ title, detail, meta, badges, actions, importance, className, children }: Props) {
  return (
    <li className={cx("relative flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start", className)}>
      {importance && (
        <span aria-hidden className={cx("absolute left-0 top-4 bottom-4 w-[3px] rounded-r-sm", IMPORTANCE_STYLE[importance].rule)} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="font-heading text-h3 text-text break-words">{title}</h3>
          {badges}
        </div>
        {detail && <div className="mt-1 text-body text-text-muted break-words">{detail}</div>}
        {meta && <div className="mt-2 font-mono text-data text-text-muted">{meta}</div>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </li>
  );
}
