"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { icons, type IconName } from "./icons";
import { cx } from "./cx";

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  count?: number;
  countLabel?: string;
  urgent?: boolean;
  /** false = not in the mobile bottom tab bar (five fit); shown as an icon link in the mobile top bar instead. */
  tabBar?: boolean;
};

/** Mobile top bar: the items that don't fit in the tab bar, as icon links. */
export function TopBarLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <>
      {items
        .filter((i) => i.tabBar === false)
        .map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              className={cx(
                "flex h-11 w-11 items-center justify-center rounded-md focus-visible:outline-accent",
                active ? "text-nav-text" : "text-nav-muted hover:text-nav-text",
              )}
            >
              {icons[item.icon]}
            </Link>
          );
        })}
    </>
  );
}

function isActive(pathname: string, href: string) {
  return href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function Count({ item }: { item: NavItem }) {
  if (!item.count) return null;
  return (
    <span
      className={cx(
        "ml-auto rounded-pill px-1.5 font-mono text-data leading-5",
        item.urgent ? "bg-danger text-danger-text" : "bg-accent text-accent-text",
      )}
    >
      {item.count}
      <span className="sr-only"> {item.countLabel}</span>
    </span>
  );
}

/** Desktop: vertical list in the side rail. */
export function SideNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cx(
                "relative flex min-h-touch items-center gap-3 rounded-md px-3 text-body transition-colors duration-fast",
                "focus-visible:outline-accent",
                active ? "bg-white/[0.07] text-nav-text" : "text-nav-muted hover:text-nav-text hover:bg-white/[0.04]",
              )}
            >
              {active && <span aria-hidden className="absolute -left-3 top-2 bottom-2 w-[3px] rounded-r-sm bg-accent" />}
              {icons[item.icon]}
              <span>{item.label}</span>
              <Count item={item} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Mobile: bottom tab bar. */
export function TabBar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <ul className="grid grid-cols-5">
      {items.filter((i) => i.tabBar !== false).map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cx(
                "relative flex h-16 flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium leading-none",
                "focus-visible:outline-accent focus-visible:-outline-offset-4",
                active ? "text-nav-text" : "text-nav-muted",
              )}
            >
              {active && <span aria-hidden className="absolute top-0 left-1/4 right-1/4 h-[3px] rounded-b-sm bg-accent" />}
              <span className="relative">
                {icons[item.icon]}
                {!!item.count && (
                  <span
                    className={cx(
                      "absolute -right-2.5 -top-1.5 min-w-[1.125rem] rounded-pill px-1 text-center font-mono text-[0.625rem] leading-[1.125rem]",
                      item.urgent ? "bg-danger text-danger-text" : "bg-accent text-accent-text",
                    )}
                  >
                    {item.count}
                    <span className="sr-only"> {item.countLabel}</span>
                  </span>
                )}
              </span>
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
