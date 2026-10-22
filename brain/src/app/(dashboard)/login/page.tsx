import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/dashboard/guard";
import { hasOwnerSession } from "@/lib/dashboard/owner";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNextPath((await searchParams).next);
  if (await hasOwnerSession()) redirect(next);
  return (
    <main className="grid min-h-dvh bg-bg text-text md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <section className="hidden flex-col justify-between bg-nav p-10 text-nav-text md:flex">
        <span className="flex items-center gap-2 font-heading text-[1.25rem] font-semibold tracking-[-0.02em]">
          <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-accent" />
          SideKiqq
        </span>
        <div className="max-w-[22ch]">
          <p className="font-heading text-display">It goes where you go.</p>
        </div>
        <p className="max-w-[44ch] text-small text-nav-muted">
          Nothing leaves your outbox until you approve it. Every draft waits here, on your watch, or in your glasses for an explicit yes.
        </p>
      </section>
      <section className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[24rem]">
          <span className="mb-8 flex items-center gap-2 font-heading text-[1.25rem] font-semibold tracking-[-0.02em] md:hidden">
            <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-accent" />
            SideKiqq
          </span>
          <h1 className="font-heading text-h1">Sign in</h1>
          <p className="mb-6 mt-1 text-body text-text-muted">This dashboard has one owner.</p>
          <LoginForm next={next} />
        </div>
      </section>
    </main>
  );
}
