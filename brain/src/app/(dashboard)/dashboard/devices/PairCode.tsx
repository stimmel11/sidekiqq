"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass } from "@/components/ui/Button";
import { createPairCodeAction, type PairCodeState } from "../actions";

function Submit({ again }: { again: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass("primary", "md")}>
      {pending ? "Creating…" : again ? "New code" : "Create pairing code"}
    </button>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [left, setLeft] = useState(() => Math.max(0, Date.parse(expiresAt) - Date.now()));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Date.parse(expiresAt) - Date.now())), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (left <= 0) return <span className="text-danger-ink">expired, create a new one</span>;
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return (
    <span>
      expires in {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

export function PairCode() {
  const [state, action] = useActionState<PairCodeState, FormData>(createPairCodeAction, undefined);
  return (
    <div className="flex flex-col gap-5">
      <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-2">
          <label htmlFor="label" className="text-small font-medium text-text">
            Label <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <input
            id="label"
            name="label"
            maxLength={64}
            placeholder="Galaxy Watch"
            className="min-h-touch w-full rounded-md border border-line-strong bg-surface px-3 text-body text-text placeholder:text-text-faint"
          />
        </div>
        <Submit again={Boolean(state?.code)} />
      </form>
      <div aria-live="polite">
        {state?.error && (
          <p role="alert" className="text-body text-danger-ink">
            {state.error}
          </p>
        )}
        {state?.code && state.expiresAt && (
          <div className="rounded-lg border border-line bg-surface-sunken px-5 py-5">
            <p className="text-small text-text-muted">Enter this code on the device{state.label ? ` (${state.label})` : ""}:</p>
            <p className="mt-2 font-mono text-[2.5rem] font-medium leading-none tracking-[0.2em] text-text" aria-label={`Pairing code ${state.code.split("").join(" ")}`}>
              {state.code.slice(0, 3)}
              <span aria-hidden className="inline-block w-3" />
              {state.code.slice(3)}
            </p>
            <p className="mt-3 font-mono text-data text-text-muted">
              single use, <Countdown expiresAt={state.expiresAt} />
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
