import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/rbac";
import { ROLES } from "@/lib/constants";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { User } from "@/models/User";
import { Tenancy } from "@/models/Tenancy";
import { objectIdSchema } from "@/lib/validators/building";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { AssignTenantForm } from "./forms";
import { vacateUnit, setTenantActive } from "./actions";

export default async function BuildingTenantsPage(props: {
  params: Promise<{ buildingId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== ROLES.SUPER_ADMIN) redirect("/dashboard");

  const { buildingId } = await props.params;
  if (!objectIdSchema.safeParse(buildingId).success) notFound();

  await connectDB();
  const building = await Building.findById(buildingId).lean();
  if (!building) notFound();

  const [units, tenancies] = await Promise.all([
    Unit.find({ buildingId }).sort({ floorNumber: 1, label: 1 }).lean(),
    Tenancy.find({ buildingId }).sort({ createdAt: -1 }).lean(),
  ]);

  const userIds = [...new Set(tenancies.map((t) => String(t.userId)))];
  const users = await User.find({ _id: { $in: userIds } }).lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  const activeByUnit = new Map<string, (typeof tenancies)[number]>();
  const activeByUser = new Map<string, (typeof tenancies)[number]>();
  for (const t of tenancies) {
    if (t.isActive) {
      activeByUnit.set(String(t.unitId), t);
      activeByUser.set(String(t.userId), t);
    }
  }
  const unitLabel = new Map(units.map((u) => [String(u._id), u.label]));

  // Existing tenants that aren't currently occupying a unit — offered for
  // reuse when assigning, so a returning tenant isn't recreated.
  const availableTenants = users
    .filter((u) => !activeByUser.has(String(u._id)))
    .map((u) => ({
      id: String(u._id),
      name: u.name,
      nid: u.nid ?? null,
    }));

  const occupiedCount = activeByUnit.size;

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/admin/buildings/${buildingId}`}
          className="text-sm text-black/55 hover:text-foreground dark:text-white/55"
        >
          ← Back to building
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">
          Tenants · {building.name}
        </h1>
        <p className="mt-1 text-sm text-black/55 dark:text-white/55">
          {occupiedCount} of {units.length} unit{units.length === 1 ? "" : "s"}{" "}
          occupied. Assigning a tenant to an occupied unit reassigns it and
          keeps the previous tenant&apos;s history.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:items-start">
        {/* Units */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
            Units &amp; occupancy
          </h2>

          {units.length === 0 ? (
            <div className="rounded-lg border border-dashed border-black/15 p-10 text-center text-black/55 dark:border-white/20 dark:text-white/55">
              This building has no units yet. Add units first.
            </div>
          ) : (
            <div className="space-y-2">
              {units.map((u) => {
                const uid = String(u._id);
                const tenancy = activeByUnit.get(uid);
                const tenant = tenancy
                  ? userMap.get(String(tenancy.userId))
                  : null;

                return (
                  <div
                    key={uid}
                    className="rounded-lg border border-black/10 p-3 dark:border-white/15"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{u.label}</span>
                        <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-black/50 dark:bg-white/10 dark:text-white/50">
                          F{u.floorNumber}
                        </span>
                      </div>
                      {tenant ? (
                        <span className="inline-flex items-center rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                          Occupied
                        </span>
                      ) : (
                        <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs font-medium text-black/50 dark:bg-white/10 dark:text-white/50">
                          Vacant
                        </span>
                      )}
                    </div>

                    {tenant ? (
                      <div className="mt-2 text-sm">
                        <Link
                          href={`/admin/buildings/${buildingId}/tenants/${String(
                            tenant._id,
                          )}`}
                          className="font-medium hover:underline"
                        >
                          {tenant.name}
                        </Link>
                        {tenant.nid || tenant.phone ? (
                          <p className="text-xs text-black/55 dark:text-white/55">
                            {tenant.nid ? `NID ${tenant.nid}` : ""}
                            {tenant.nid && tenant.phone ? " · " : ""}
                            {tenant.phone ?? ""}
                          </p>
                        ) : null}
                        <form action={vacateUnit} className="mt-2">
                          <input type="hidden" name="unitId" value={uid} />
                          <ConfirmSubmit
                            message={`Vacate unit ${u.label}? This ends ${tenant.name}'s occupancy.`}
                            className="inline-flex h-8 items-center justify-center rounded-md border border-black/15 px-3 text-xs font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
                          >
                            Vacate unit
                          </ConfirmSubmit>
                        </form>
                        <AssignTenantForm
                          buildingId={buildingId}
                          unitId={uid}
                          mode="reassign"
                          availableTenants={availableTenants}
                          buildingAddress={building.address ?? null}
                        />
                      </div>
                    ) : (
                      <AssignTenantForm
                        buildingId={buildingId}
                        unitId={uid}
                        mode="assign"
                        availableTenants={availableTenants}
                        buildingAddress={building.address ?? null}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Tenants */}
        <section className="space-y-3 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
            All tenants ({users.length})
          </h2>

          {users.length === 0 ? (
            <div className="rounded-lg border border-dashed border-black/15 p-10 text-center text-black/55 dark:border-white/20 dark:text-white/55">
              No tenants in this building yet.
            </div>
          ) : (
            <div className="divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/15">
              {users.map((t) => {
                const id = String(t._id);
                const active = activeByUser.get(id);
                const currentUnit = active
                  ? unitLabel.get(String(active.unitId))
                  : null;
                return (
                  <div
                    key={id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/admin/buildings/${buildingId}/tenants/${id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {t.name}
                      </Link>
                      <p className="truncate text-xs text-black/55 dark:text-white/55">
                        {currentUnit ? `Unit ${currentUnit}` : "No unit"}
                        {t.nid ? ` · NID ${t.nid}` : ""}
                        {t.phone ? ` · ${t.phone}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {t.isActive ? (
                        <span className="text-xs text-green-600 dark:text-green-400">
                          Active
                        </span>
                      ) : (
                        <span className="text-xs text-black/45 dark:text-white/45">
                          Inactive
                        </span>
                      )}
                      <form action={setTenantActive}>
                        <input type="hidden" name="userId" value={id} />
                        <input
                          type="hidden"
                          name="buildingId"
                          value={buildingId}
                        />
                        <input
                          type="hidden"
                          name="active"
                          value={t.isActive ? "false" : "true"}
                        />
                        {t.isActive ? (
                          <ConfirmSubmit
                            message={`Deactivate ${t.name}? This also vacates their unit if occupied.`}
                            className="inline-flex h-7 items-center justify-center rounded-md border border-red-500/40 px-2.5 text-xs font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
                          >
                            Deactivate
                          </ConfirmSubmit>
                        ) : (
                          <button
                            type="submit"
                            className="inline-flex h-7 items-center justify-center rounded-md border border-black/15 px-2.5 text-xs font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
                          >
                            Reactivate
                          </button>
                        )}
                      </form>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
