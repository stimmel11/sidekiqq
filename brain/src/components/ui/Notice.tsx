import type { ReactNode } from "react";
import { cx } from "./cx";

/** Inline status line after an action. role=status so screen readers announce it. */
export function Notice({ tone = "success", children }: { tone?: "success" | "danger"; children: ReactNode }) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cx(
        "rounded-md border px-4 py-3 text-body",
        tone === "danger" ? "border-danger text-danger-ink" : "border-success text-success-ink",
      )}
    >
      {children}
    </p>
  );
}
