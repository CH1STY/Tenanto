import Link from "next/link";
import { getCurrentUser } from "@/lib/rbac";
import { ROLES } from "@/lib/constants";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { User } from "@/models/User";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  const isSuperAdmin = user?.role === ROLES.SUPER_ADMIN;

  // Buildings this user can manage: all for a SuperAdmin, assigned ones for a
  // Manager. Listed with direct links so the cash book is one click away.
  await connectDB();
  let buildingFilter: Record<string, unknown> | null = null;
  if (isSuperAdmin) {
    buildingFilter = {};
  } else if (user?.role === ROLES.MANAGER) {
    const doc = await User.findById(user.id)
      .select("managedBuildingIds")
      .lean();
    buildingFilter = { _id: { $in: doc?.managedBuildingIds ?? [] } };
  }
  const buildings = buildingFilter
    ? await Building.find(buildingFilter)
        .select("name address")
        .sort({ name: 1 })
        .lean()
    : [];

  return (
    <div>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-sm text-black/55 dark:text-white/55">
        Welcome back, {user?.name}.
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Your buildings
        </h2>
        {buildings.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-black/15 p-8 text-center text-sm text-black/55 dark:border-white/20 dark:text-white/55">
            {isSuperAdmin
              ? "No buildings yet. Create one under Buildings."
              : "No buildings have been assigned to you yet. Ask a Super Admin for access."}
          </div>
        ) : (
          <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {buildings.map((b) => {
              const id = String(b._id);
              return (
                <li
                  key={id}
                  className="flex flex-col rounded-lg border border-black/10 p-5 dark:border-white/15"
                >
                  <h3 className="text-base font-semibold">{b.name}</h3>
                  {b.address ? (
                    <p className="mt-1 text-sm text-black/55 dark:text-white/55">
                      {b.address}
                    </p>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Link
                      href={`/admin/buildings/${id}/ledger`}
                      className="inline-flex h-9 flex-1 items-center justify-center rounded-md bg-foreground px-3 text-sm font-medium text-background hover:opacity-90"
                    >
                      Cash book
                    </Link>
                    <Link
                      href={`/admin/buildings/${id}/tenants`}
                      className="inline-flex h-9 items-center justify-center rounded-md border border-black/15 px-3 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
                    >
                      Tenants
                    </Link>
                    <Link
                      href={`/buildings/${id}`}
                      className="inline-flex h-9 items-center justify-center rounded-md border border-black/15 px-3 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
                    >
                      Status
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {isSuperAdmin ? (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
            Administration
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card
              href="/admin/buildings"
              title="Buildings"
              body="Create buildings and configure their floors and units."
            />
            <Card
              href="/admin/managers"
              title="Admins"
              body="Add admins, grant access to specific buildings, and deactivate them."
            />
            <Card
              href="/admin/audit-logs"
              title="Audit logs"
              body="Review every create, edit and delete across the system, filtered by date."
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Card({
  href,
  title,
  body,
}: {
  href: string;
  title: string;
  body: string;
}) {
  return (
    <Link href={href}>
      <div className="h-full rounded-lg border border-black/10 p-5 transition-colors hover:bg-black/3 dark:border-white/15 dark:hover:bg-white/5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-black/55 dark:text-white/55">{body}</p>
      </div>
    </Link>
  );
}
