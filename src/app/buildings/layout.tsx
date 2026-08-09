import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { getCurrentUser } from "@/lib/rbac";
import { getActiveBuildingId } from "@/lib/active-building";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { objectIdSchema } from "@/lib/validators/building";

async function getActiveBuildingName(): Promise<{
  id: string;
  name: string;
} | null> {
  const id = await getActiveBuildingId();
  if (!id || !objectIdSchema.safeParse(id).success) return null;
  await connectDB();
  const b = await Building.findById(id).select("name").lean();
  if (!b) return null;
  return { id, name: b.name };
}

export default async function BuildingsLayout({
  children,
}: LayoutProps<"/buildings">) {
  const [user, active] = await Promise.all([
    getCurrentUser(),
    getActiveBuildingName(),
  ]);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-black/10 dark:border-white/15">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <nav className="flex min-w-0 items-center gap-3 overflow-x-auto sm:gap-6">
            <Link
              href="/"
              className="shrink-0 text-sm font-bold tracking-tight"
            >
              Tenant App
            </Link>
            <Link
              href="/buildings"
              className="shrink-0 text-sm text-black/60 hover:text-foreground dark:text-white/60"
            >
              Buildings
            </Link>
            {active ? (
              <Link
                href={`/buildings/${active.id}`}
                className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap text-sm text-black/60 hover:text-foreground dark:text-white/60 sm:inline-flex"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                {active.name}
              </Link>
            ) : null}
          </nav>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <ThemeToggle />
            {user ? (
              <Link
                href="/dashboard"
                className="inline-flex h-9 items-center justify-center rounded-md bg-foreground px-3 text-sm font-medium text-background hover:opacity-90"
              >
                Dashboard
              </Link>
            ) : (
              <Link
                href="/login"
                className="inline-flex h-9 items-center justify-center rounded-md border border-black/15 px-3 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </div>
    </div>
  );
}
