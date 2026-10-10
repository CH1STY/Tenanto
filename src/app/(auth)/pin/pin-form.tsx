"use client";

import Link from "next/link";
import { useActionState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { unlockPublicPages, type PinState } from "./actions";

const initialState: PinState = { error: null };

export function PinForm({ returnTo }: { returnTo: string }) {
  const [state, formAction, pending] = useActionState(
    unlockPublicPages,
    initialState,
  );

  return (
    <main className="relative flex flex-1 items-center justify-center px-6 py-16">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-lg font-bold tracking-tight">Tenant App</p>
          <h1 className="mt-6 text-2xl font-semibold">Enter access PIN</h1>
          <p className="mt-2 text-sm text-black/55 dark:text-white/55">
            Enter the shared four-digit PIN to view the website for six hours,
            or sign in to continue without a PIN.
          </p>
        </div>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="returnTo" value={returnTo} />
          <div>
            <label htmlFor="pin" className="mb-1.5 block text-sm font-medium">
              Access PIN
            </label>
            <input
              id="pin"
              name="pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]{4}"
              minLength={4}
              maxLength={4}
              autoComplete="off"
              required
              className="h-11 w-full rounded-md border border-black/15 bg-transparent px-3 text-center text-lg tracking-widest outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
            />
          </div>
          {state.error ? (
            <p
              role="alert"
              className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
            >
              {state.error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-11 w-full items-center justify-center rounded-md bg-foreground text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {pending ? "Checking PIN..." : "Continue"}
          </button>
        </form>
        <Link
          href="/login"
          className="mt-6 block text-center text-sm underline underline-offset-4"
        >
          Sign in instead
        </Link>
      </div>
    </main>
  );
}
