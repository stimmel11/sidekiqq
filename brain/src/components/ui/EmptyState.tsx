import type { ReactNode } from "react";

/** An empty screen tells the owner what it means and what to do next. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-line-strong px-5 py-8">
      <h2 className="font-heading text-h3 text-text">{title}</h2>
      {children && <div className="max-w-[60ch] text-body text-text-muted">{children}</div>}
      {action}
    </div>
  );
}
