import type { ButtonHTMLAttributes, AnchorHTMLAttributes } from "react";
import Link from "next/link";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-body font-medium whitespace-nowrap select-none " +
  "transition-colors duration-fast ease-sk disabled:opacity-50 disabled:cursor-not-allowed min-h-touch";

const variants: Record<ButtonVariant, string> = {
  // Signal is the one accent: the primary action on a screen.
  primary: "bg-accent text-accent-text hover:brightness-95 active:brightness-90",
  secondary: "border border-line-strong bg-surface text-text hover:bg-surface-sunken",
  danger: "bg-danger text-danger-text hover:brightness-95 active:brightness-90",
  ghost: "text-text-muted hover:text-text hover:bg-surface-sunken",
};

const sizes: Record<ButtonSize, string> = {
  sm: "px-3 text-small",
  md: "px-4 text-body",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string) {
  return cx(base, variants[variant], sizes[size], extra);
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize };

export function Button({ variant = "secondary", size = "md", className, type = "button", ...rest }: Props) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; variant?: ButtonVariant; size?: ButtonSize };

export function ButtonLink({ variant = "secondary", size = "md", className, href, ...rest }: LinkProps) {
  return <Link href={href} className={buttonClass(variant, size, className)} {...rest} />;
}
