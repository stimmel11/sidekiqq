"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { handoffLink } from "@/lib/commands/links";
import { ackHandoff, fetchHandoffs, POLL_MS, type HandoffItem } from "@/lib/handoffs/browser-api";

/**
 * Hand-offs waiting for this browser (docs/WEBAPP.md §7): "call Dana" or a meeting join link
 * queued for the owner's `web` device. Read from `GET /api/commands` while the page is visible
 * (every 15 s, and on focus). Each card shows the brain's `label`, then the number or host on its
 * own line, then a link built from the re-checked fields (never from `label`).
 *
 * Nothing opens by itself: no window.open, no location change, no programmatic click. The owner
 * taps the link (that tap acks `opened`) or Dismiss (acks `dismissed`). A command that fails the
 * browser's check shows "Can't open this hand-off" and is acked `failed` once.
 */
export function HandoffCards() {
  const [items, setItems] = useState<HandoffItem[]>([]);
  // Acked here: hidden at once, even before the next GET stops listing them.
  const done = useRef(new Set<string>());
  const failedAcked = useRef(new Set<string>());
  const stopped = useRef(false);

  const refresh = useCallback(async () => {
    if (stopped.current || document.visibilityState !== "visible") return;
    const r = await fetchHandoffs();
    if (!r.ok) {
      // Signed out: stop polling; the next navigation goes to the sign-in page.
      if (r.status === 401) stopped.current = true;
      return;
    }
    const live = r.items.filter((c) => !done.current.has(c.id));
    for (const c of live) {
      if (!handoffLink(c).ok && !failedAcked.current.has(c.id)) {
        failedAcked.current.add(c.id);
        void ackHandoff(c.id, "failed");
      }
    }
    setItems(live);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onShow = () => void refresh();
    window.addEventListener("focus", onShow);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onShow);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [refresh]);

  const finish = useCallback((id: string, result: "opened" | "dismissed") => {
    if (done.current.has(id)) return;
    done.current.add(id);
    // Already acked `failed` (a check failed): just hide it.
    if (!failedAcked.current.has(id)) void ackHandoff(id, result);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  if (items.length === 0) return null;
  return (
    <section aria-label="Hand-offs waiting" className="mb-6 space-y-3">
      {items.map((c) => {
        const link = handoffLink(c);
        return (
          <article key={c.id} className="rounded-lg border border-accent bg-surface px-5 py-4">
            <p className="text-small text-text-muted">Waiting for your tap</p>
            <p className="mt-1 font-heading text-h3 text-text">{c.label}</p>
            {link.ok ? (
              <>
                <p className="mt-1 font-mono text-body text-text">{link.detail}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href={link.href}
                    {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    className={buttonClass("primary", "md")}
                    onClick={() => finish(c.id, "opened")}
                  >
                    {link.action}
                  </a>
                  <Button variant="ghost" onClick={() => finish(c.id, "dismissed")}>
                    Dismiss
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-1 text-body text-danger-ink">Can&apos;t open this hand-off.</p>
                <div className="mt-3">
                  <Button variant="ghost" onClick={() => finish(c.id, "dismissed")}>
                    Dismiss
                  </Button>
                </div>
              </>
            )}
          </article>
        );
      })}
    </section>
  );
}
