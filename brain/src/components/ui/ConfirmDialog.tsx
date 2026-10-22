"use client";

import { useActionState, useEffect, useId, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass, type ButtonVariant } from "./Button";
import { Notice } from "./Notice";

export type ConfirmState = { error?: string } | undefined;

type Props = {
  /** Text on the button that opens the dialog. */
  triggerLabel: string;
  triggerVariant?: ButtonVariant;
  title: string;
  /** What the owner is confirming. Shown in full inside the dialog. */
  children: ReactNode;
  /** Server action run only from the dialog's confirm button. */
  action: (state: ConfirmState, form: FormData) => Promise<ConfirmState>;
  /** Hidden fields posted with the confirmation. */
  fields: Record<string, string>;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  /** Name/value carried only by the confirm button, so the server can require it. */
  confirmName?: string;
  confirmValue?: string;
  pendingLabel?: string;
};

function ConfirmButton({ label, pendingLabel, variant, name, value }: { label: string; pendingLabel: string; variant: ButtonVariant; name?: string; value?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} disabled={pending} aria-disabled={pending} className={buttonClass(variant, "md")}>
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * Modal confirmation on the native <dialog> (focus is trapped and Escape closes it).
 * Focus starts on Cancel, never on the destructive/sending action.
 */
export function ConfirmDialog({
  triggerLabel,
  triggerVariant = "primary",
  title,
  children,
  action,
  fields,
  confirmLabel,
  confirmVariant = "primary",
  confirmName,
  confirmValue,
  pendingLabel = "Working…",
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [state, formAction] = useActionState(action, undefined);

  useEffect(() => {
    if (state?.error && !ref.current?.open) ref.current?.showModal();
  }, [state]);

  return (
    <>
      <button
        type="button"
        className={buttonClass(triggerVariant, "md")}
        onClick={() => {
          ref.current?.showModal();
          cancelRef.current?.focus();
        }}
      >
        {triggerLabel}
      </button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        className="m-auto w-[min(36rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] rounded-lg border border-line bg-surface p-0 text-text shadow-[0_24px_64px_-16px_rgba(15,20,32,0.45)] backdrop:bg-[var(--sk-scrim)]"
      >
        <form action={formAction} className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <header className="border-b border-line px-5 py-4">
            <h2 id={titleId} className="font-heading text-h2">
              {title}
            </h2>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {state?.error && (
            <div className="px-5 pb-2">
              <Notice tone="danger">{state.error}</Notice>
            </div>
          )}
          {Object.entries(fields).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end">
            <button ref={cancelRef} type="button" autoFocus className={buttonClass("secondary", "md")} onClick={() => ref.current?.close()}>
              Cancel
            </button>
            <ConfirmButton label={confirmLabel} pendingLabel={pendingLabel} variant={confirmVariant} name={confirmName} value={confirmValue} />
          </footer>
        </form>
      </dialog>
    </>
  );
}
