import type { ReactNode } from "react";

export function PageHeader({ title, lede, aside }: { title: string; lede?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-heading text-h1 text-text">{title}</h1>
        {lede && <p className="mt-1 max-w-[65ch] text-body text-text-muted">{lede}</p>}
      </div>
      {aside}
    </header>
  );
}
