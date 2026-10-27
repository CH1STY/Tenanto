"use client";

import { useActionState } from "react";

type State = { error: string | null; ok?: boolean };

/**
 * A confirm-then-submit form for destructive actions that can be refused.
 * Shows the server's refusal reason under the button instead of failing
 * silently.
 */
export function ConfirmActionForm({
  action,
  fields,
  message,
  label,
  pendingLabel = "Working…",
  className,
  buttonClassName,
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  fields: Record<string, string>;
  message: string;
  label: string;
  pendingLabel?: string;
  className?: string;
  buttonClassName?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {
    error: null,
  });

  return (
    <form action={formAction} className={className}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        disabled={pending}
        className={`${buttonClassName ?? ""} disabled:opacity-60`}
        onClick={(e) => {
          if (!window.confirm(message)) e.preventDefault();
        }}
      >
        {pending ? pendingLabel : label}
      </button>
      {state.error ? (
        <p
          role="alert"
          className="mt-2 max-w-xs text-xs text-red-600 dark:text-red-400"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
