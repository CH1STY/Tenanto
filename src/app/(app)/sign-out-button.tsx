"use client";

import { signOutAction } from "./actions";

export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <button
        type="submit"
        className="inline-flex h-9 items-center justify-center rounded-md border border-black/15 px-3 text-sm font-medium transition-colors hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
      >
        Sign out
      </button>
    </form>
  );
}
