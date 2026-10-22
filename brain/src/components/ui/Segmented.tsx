import Link from "next/link";
import { cx } from "./cx";

/** Link-based segmented control (filters live in the URL, so they work without JS and can be bookmarked). */
export function Segmented({ label, items, current }: { label: string; items: { value: string; label: string; href: string }[]; current: string }) {
  return (
    <nav aria-label={label} className="inline-flex rounded-md border border-line bg-surface-sunken p-0.5">
      {items.map((i) => {
        const active = i.value === current;
        return (
          <Link
            key={i.value}
            href={i.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "inline-flex min-h-[2.5rem] items-center rounded-[6px] px-3 text-small font-medium transition-colors duration-fast",
              active ? "bg-surface text-text shadow-[0_0_0_1px_var(--sk-line)]" : "text-text-muted hover:text-text",
            )}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
