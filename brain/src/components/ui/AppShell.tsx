import type { ReactNode } from "react";
import { SideNav, TabBar, TopBarLinks, type NavItem } from "./NavLinks";

function Wordmark() {
  return (
    <span className="flex items-center gap-2 font-heading text-[1.25rem] font-semibold tracking-[-0.02em] text-nav-text">
      <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-accent" />
      SideKiqq
    </span>
  );
}

/**
 * Dashboard frame. Desktop: an Ink side rail. Under 768px the rail becomes a top bar
 * plus a bottom tab bar (thumb reach on a phone).
 */
export function AppShell({ nav, signOut, children }: { nav: NavItem[]; signOut: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg text-text md:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-text"
      >
        Skip to content
      </a>

      <aside className="hidden md:sticky md:top-0 md:flex md:h-dvh md:w-nav md:shrink-0 md:flex-col md:border-r md:border-white/5 md:bg-nav md:px-3 md:py-5">
        <div className="px-3 pb-6">
          <Wordmark />
          <p className="mt-1 text-small text-nav-muted">It goes where you go.</p>
        </div>
        <nav aria-label="Dashboard">
          <SideNav items={nav} />
        </nav>
        <div className="mt-auto px-3">{signOut}</div>
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center justify-between bg-nav px-4 md:hidden">
        <Wordmark />
        <div className="flex items-center gap-1">
          <TopBarLinks items={nav} />
          {signOut}
        </div>
      </header>

      <main id="main" className="min-w-0 flex-1 px-4 pt-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-6 md:px-10 md:pt-10 md:pb-16">
        <div className="mx-auto max-w-content">{children}</div>
      </main>

      <nav aria-label="Dashboard" className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-nav pb-[env(safe-area-inset-bottom)] md:hidden">
        <TabBar items={nav} />
      </nav>
    </div>
  );
}
