import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/rbac";
import { ROLES } from "@/lib/constants";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { BuildingCreateForm } from "./forms";
import { deleteBuilding } from "./actions";

export default async function AdminBuildingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== ROLES.SUPER_ADMIN) redirect("/dashboard");

  await connectDB();
  const [buildings, unitCounts] = await Promise.all([
    Building.find().sort({ name: 1 }).lean(),
    Unit.aggregate<{ _id: unknown; count: number }>([
      { $group: { _id: "$buildingId", count: { $sum: 1 } } },
    ]),
  ]);

  const countByBuilding = new Map(
    unitCounts.map((c) => [String(c._id), c.count]),
  );

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Manage buildings</h1>
        <p className="mt-1 text-sm text-black/55 dark:text-white/55">
          Create buildings and configure their floors and units. Every change is
          recorded in the audit log.
        </p>
      </div>

      <section className="rounded-lg border border-black/10 p-5 dark:border-white/15">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          New building
        </h2>
        <BuildingCreateForm />
      </section>

      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          All buildings ({buildings.length})
        </h2>

        {buildings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/15 p-10 text-center text-black/55 dark:border-white/20 dark:text-white/55">
            No buildings yet. Create one above.
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {buildings.map((b) => {
              const id = String(b._id);
              const units = countByBuilding.get(id) ?? 0;
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
                  <p className="mt-3 text-xs text-black/50 dark:text-white/50">
                    {b.numberOfFloors} floor{b.numberOfFloors === 1 ? "" : "s"}{" "}
                    · {units} unit{units === 1 ? "" : "s"}
                  </p>

                  <div className="mt-4 flex gap-2">
                    <Link
                      href={`/admin/buildings/${id}`}
                      className="inline-flex h-9 flex-1 items-center justify-center rounded-md bg-foreground text-sm font-medium text-background hover:opacity-90"
                    >
                      Manage
                    </Link>
                    <form action={deleteBuilding}>
                      <input type="hidden" name="buildingId" value={id} />
                      <ConfirmSubmit
                        message={`Delete "${b.name}" and all its units? This cannot be undone.`}
                        className="inline-flex h-9 items-center justify-center rounded-md border border-red-500/40 px-3 text-sm font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
                      >
                        Delete
                      </ConfirmSubmit>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
