import { AppShell } from "@/components/ui/AppShell";
import type { NavItem } from "@/components/ui/NavLinks";
import { getDeps } from "@/lib/deps";
import { navCounts } from "@/lib/dashboard/data";
import { requireOwnerSession } from "@/lib/dashboard/owner";
import { logoutAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await requireOwnerSession();
  const counts = await navCounts(getDeps());
  const nav: NavItem[] = [
    { href: "/dashboard", label: "Today", icon: "today" },
    { href: "/dashboard/followups", label: "Follow-ups", icon: "followups", count: counts.followups, countLabel: "open" },
    { href: "/dashboard/drafts", label: "Drafts", icon: "drafts", count: counts.drafts, countLabel: "awaiting approval" },
    { href: "/dashboard/commitments", label: "Commitments", icon: "commitments", count: counts.overdue, countLabel: "overdue", urgent: true },
    { href: "/dashboard/devices", label: "Devices", icon: "devices" },
  ];
  const signOut = (
    <form action={logoutAction}>
      <button
        type="submit"
        className="min-h-touch rounded-md px-2 text-small text-nav-muted transition-colors duration-fast hover:text-nav-text focus-visible:outline-accent"
      >
        Sign out
      </button>
    </form>
  );
  return (
    <AppShell nav={nav} signOut={signOut}>
      {children}
    </AppShell>
  );
}
