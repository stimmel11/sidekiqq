"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass } from "@/components/ui/Button";
import { loginAction, type LoginState } from "./actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass("primary", "md", "w-full")}>
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState<LoginState, FormData>(loginAction, undefined);
  const errorId = "login-error";
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <div className="flex flex-col gap-2">
        <label htmlFor="secret" className="text-small font-medium text-text">
          Owner secret
        </label>
        <input
          id="secret"
          name="secret"
          type="password"
          required
          autoComplete="current-password"
          autoFocus
          aria-invalid={state?.error ? true : undefined}
          aria-describedby={state?.error ? errorId : "secret-hint"}
          className="min-h-touch w-full rounded-md border border-line-strong bg-surface px-3 font-mono text-body text-text placeholder:text-text-faint focus-visible:border-text"
        />
        <p id="secret-hint" className="text-small text-text-muted">
          The OWNER_SECRET set on the server. You stay signed in on this browser for 7 days.
        </p>
      </div>
      {state?.error && (
        <p id={errorId} role="alert" className="text-small font-medium text-danger-ink">
          {state.error}
        </p>
      )}
      <Submit />
    </form>
  );
}
