import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

type Props = HTMLAttributes<HTMLElement> & {
  title?: ReactNode;
  /** Right side of the header: a count, a link, an action. */
  aside?: ReactNode;
  as?: "section" | "div" | "article";
  /** Flush cards drop inner padding so ListRows can run edge to edge. */
  flush?: boolean;
};

export function Card({ title, aside, as: Tag = "section", flush, className, children, ...rest }: Props) {
  return (
    <Tag className={cx("rounded-lg border border-line bg-surface", className)} {...rest}>
      {(title || aside) && (
        <header className="flex items-baseline justify-between gap-4 px-5 pt-4 pb-3">
          {title && <h2 className="font-heading text-h3 text-text">{title}</h2>}
          {aside && <div className="text-small text-text-muted">{aside}</div>}
        </header>
      )}
      <div className={flush ? "" : "px-5 pb-5"}>{children}</div>
    </Tag>
  );
}
