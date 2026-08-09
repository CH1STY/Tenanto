"use client";

import Link from "next/link";
import { useActionState } from "react";
import { login, type LoginState } from "./actions";
import { ThemeToggle } from "@/components/theme-toggle";

const initialState: LoginState = { error: null };

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <main className="relative flex flex-1 items-center justify-center px-6 py-16">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Tenant App
          </Link>
          <h1 className="mt-6 text-2xl font-semibold">Sign in</h1>
          <p className="mt-2 text-sm text-black/55 dark:text-white/55">
            SuperAdmin and Manager access only.
          </p>
        </div>

        <form action={formAction} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="h-11 w-full rounded-md border border-black/15 bg-transparent px-3 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1.5 block text-sm font-medium"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="h-11 w-full rounded-md border border-black/15 bg-transparent px-3 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
              placeholder="••••••••"
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
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
