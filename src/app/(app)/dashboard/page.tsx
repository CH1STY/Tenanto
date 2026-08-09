import Link from "next/link";
import { getCurrentUser } from "@/lib/rbac";
import { ROLES } from "@/lib/constants";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  const isSuperAdmin = user?.role === ROLES.SUPER_ADMIN;

  return (
    <div>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-sm text-black/55 dark:text-white/55">
        Welcome back, {user?.name}.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {isSuperAdmin ? (
          <Card
            href="/admin/audit-logs"
            title="Audit logs"
            body="Review every create, edit and delete across the system, filtered by date."
          />
        ) : null}
        {isSuperAdmin ? (
          <Card
            href="/admin/buildings"
            title="Buildings"
            body="Create buildings and configure their floors and units."
          />
        ) : (
          <Card
            title="Buildings"
            body="Building, floor and unit management."
            disabled
          />
        )}
        <Card
          title="Monthly cash book"
          body="Open a month, record payments, expenses and withdrawals — coming next."
          disabled
        />
      </div>
    </div>
  );
}

function Card({
  href,
  title,
  body,
  disabled,
}: {
  href?: string;
  title: string;
  body: string;
  disabled?: boolean;
}) {
  const inner = (
    <div
      className={`h-full rounded-lg border border-black/10 p-5 dark:border-white/15 ${
        disabled
          ? "opacity-50"
          : "transition-colors hover:bg-black/3 dark:hover:bg-white/5"
      }`}
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-black/55 dark:text-white/55">{body}</p>
      {disabled ? (
        <span className="mt-3 inline-block text-xs text-black/40 dark:text-white/40">
          Coming soon
        </span>
      ) : null}
    </div>
  );

  if (href && !disabled) {
    return <Link href={href}>{inner}</Link>;
  }
  return inner;
}
