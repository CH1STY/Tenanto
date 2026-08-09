import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/rbac";
import { ROLES } from "@/lib/constants";
import { SignOutButton } from "./sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const isSuperAdmin = user.role === ROLES.SUPER_ADMIN;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-black/10 dark:border-white/15">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <nav className="flex min-w-0 items-center gap-3 overflow-x-auto sm:gap-6">
            <Link
              href="/dashboard"
              className="shrink-0 text-sm font-bold tracking-tight"
            >
              Tenant App
            </Link>
            <Link
              href="/dashboard"
              className="shrink-0 text-sm text-black/60 hover:text-foreground dark:text-white/60"
            >
              Dashboard
            </Link>
            {isSuperAdmin ? (
              <Link
                href="/admin/buildings"
                className="shrink-0 whitespace-nowrap text-sm text-black/60 hover:text-foreground dark:text-white/60"
              >
                Buildings
              </Link>
            ) : null}
            {isSuperAdmin ? (
              <Link
                href="/admin/audit-logs"
                className="shrink-0 whitespace-nowrap text-sm text-black/60 hover:text-foreground dark:text-white/60"
              >
                Audit logs
              </Link>
            ) : null}
          </nav>

          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <span className="hidden text-right text-xs sm:block">
              <span className="block font-medium">{user.name}</span>
              <span className="block text-black/50 dark:text-white/50">
                {user.role}
              </span>
            </span>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </div>
    </div>
  );
}
