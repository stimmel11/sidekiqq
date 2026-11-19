"use client";

import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { buttonClass } from "@/components/ui/Button";
import { completeCommitment } from "@/lib/dashboard/browser-api";

function Submit({ what }: { what: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending} className={buttonClass("secondary", "sm")}>
      {pending ? "Saving…" : "Mark complete"}
      <span className="sr-only">: {what}</span>
    </button>
  );
}

/** Marks one commitment done from the browser as the signed-in session. Never sends anything. */
export function CompleteButton({ id, what, back }: { id: string; what: string; back: "open" | "overdue" | "all" }) {
  const router = useRouter();
  async function complete(): Promise<void> {
    const r = await completeCommitment(id);
    router.replace(`/dashboard/commitments?status=${back}&done=${r.ok ? "completed" : "error"}`);
    router.refresh();
  }
  return (
    <form action={complete}>
      <Submit what={what} />
    </form>
  );
}
