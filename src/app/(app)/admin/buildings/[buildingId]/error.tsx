"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function BuildingAdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Logged client-side only; the digest matches the server-side log entry.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <p className="text-sm text-black/55 dark:text-white/55">
        This building page could not be loaded. Try again, or go back to your
        dashboard.
      </p>
      {error.digest ? (
        <p className="text-xs text-black/50 dark:text-white/50">
          Reference: {error.digest}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="inline-flex h-9 items-center justify-center rounded-md border border-black/10 px-4 text-sm font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
