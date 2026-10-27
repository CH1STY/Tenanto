import { notFound, redirect } from "next/navigation";
import { getCurrentUser, userManagesBuilding } from "@/lib/rbac";
import { ROLES } from "@/lib/constants";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { objectIdSchema } from "@/lib/validators/building";
import { ConfirmActionForm } from "@/components/confirm-action-form";
import { BuildingEditForm, UnitCreateForm, UnitEditRow } from "../forms";
import { deleteUnit } from "../actions";

export default async function ManageBuildingPage(props: {
  params: Promise<{ buildingId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { buildingId } = await props.params;
  if (!objectIdSchema.safeParse(buildingId).success) notFound();
  if (!(await userManagesBuilding(buildingId, user))) redirect("/dashboard");
  // Building details and units are SuperAdmin-only; managers land on the
  // cash book instead of an empty page.
  if (user.role !== ROLES.SUPER_ADMIN) {
    redirect(`/admin/buildings/${buildingId}/ledger`);
  }

  await connectDB();
  const [building, units] = await Promise.all([
    Building.findById(buildingId).lean(),
    Unit.find({ buildingId }).sort({ floorNumber: 1, label: 1 }).lean(),
  ]);
  if (!building) notFound();

  const floors = new Map<number, typeof units>();
  for (const u of units) {
    const list = floors.get(u.floorNumber) ?? [];
    list.push(u);
    floors.set(u.floorNumber, list);
  }
  const sortedFloors = [...floors.keys()].sort((a, b) => a - b);

  return (
    <div className="space-y-10">
      <section className="rounded-lg border border-black/10 p-5 dark:border-white/15">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Building details
        </h2>
        <BuildingEditForm
          building={{
            id: String(building._id),
            name: building.name,
            address: building.address ?? null,
            numberOfFloors: building.numberOfFloors,
          }}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Units ({units.length})
        </h2>

        <UnitCreateForm buildingId={String(building._id)} />

        {units.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/15 p-10 text-center text-black/55 dark:border-white/20 dark:text-white/55">
            No units yet. Add one above.
          </div>
        ) : (
          <div className="space-y-6">
            {sortedFloors.map((floor) => (
              <div key={floor}>
                <h3 className="mb-2 text-sm font-medium text-black/70 dark:text-white/70">
                  Floor {floor}
                </h3>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {floors.get(floor)!.map((u) => (
                    <div
                      key={String(u._id)}
                      className="flex items-start gap-2"
                    >
                      <div className="flex-1">
                        <UnitEditRow
                          unit={{
                            id: String(u._id),
                            label: u.label,
                            floorNumber: u.floorNumber,
                            serviceChargeAmount: u.serviceChargeAmount ?? 0,
                          }}
                        />
                      </div>
                      <ConfirmActionForm
                        action={deleteUnit}
                        fields={{ unitId: String(u._id) }}
                        className="pt-6"
                        message={`Delete unit "${u.label}"?`}
                        label="Delete"
                        pendingLabel="Deleting…"
                        buttonClassName="inline-flex h-9 items-center justify-center rounded-md border border-red-500/40 px-3 text-sm font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
