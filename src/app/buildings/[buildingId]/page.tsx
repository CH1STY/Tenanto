import Link from "next/link";
import { notFound } from "next/navigation";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { getActiveBuildingId } from "@/lib/active-building";
import { objectIdSchema } from "@/lib/validators/building";
import { setActiveBuilding } from "../actions";

export default async function BuildingDetailPage(props: {
  params: Promise<{ buildingId: string }>;
}) {
  const { buildingId } = await props.params;
  if (!objectIdSchema.safeParse(buildingId).success) notFound();

  await connectDB();

  const [building, units, activeId] = await Promise.all([
    Building.findById(buildingId).lean(),
    Unit.find({ buildingId }).sort({ floorNumber: 1, label: 1 }).lean(),
    getActiveBuildingId(),
  ]);

  if (!building) notFound();

  const isActive = activeId === buildingId;

  // Group units by floor for display.
  const floors = new Map<number, typeof units>();
  for (const u of units) {
    const list = floors.get(u.floorNumber) ?? [];
    list.push(u);
    floors.set(u.floorNumber, list);
  }
  const sortedFloors = [...floors.keys()].sort((a, b) => a - b);

  return (
    <div>
      <Link
        href="/buildings"
        className="text-sm text-black/55 hover:text-foreground dark:text-white/55"
      >
        ← All buildings
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{building.name}</h1>
          {building.address ? (
            <p className="mt-1 text-sm text-black/55 dark:text-white/55">
              {building.address}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-black/50 dark:text-white/50">
            {building.numberOfFloors} floor
            {building.numberOfFloors === 1 ? "" : "s"} · {units.length} unit
            {units.length === 1 ? "" : "s"}
          </p>
        </div>

        {isActive ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/15 px-3 py-1 text-sm font-medium text-green-700 dark:text-green-400">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            Active building
          </span>
        ) : (
          <form action={setActiveBuilding}>
            <input type="hidden" name="buildingId" value={buildingId} />
            <button
              type="submit"
              className="inline-flex h-9 items-center justify-center rounded-md border border-black/15 px-4 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
            >
              Set as active building
            </button>
          </form>
        )}
      </div>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
        Floors &amp; units
      </h2>

      {units.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-black/15 p-10 text-center text-black/55 dark:border-white/20 dark:text-white/55">
          No units have been configured for this building yet.
        </div>
      ) : (
        <div className="mt-4 space-y-6">
          {sortedFloors.map((floor) => (
            <div key={floor}>
              <h3 className="mb-2 text-sm font-medium text-black/70 dark:text-white/70">
                Floor {floor}
              </h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {floors.get(floor)!.map((u) => (
                  <div
                    key={String(u._id)}
                    className="rounded-lg border border-black/10 p-4 dark:border-white/15"
                  >
                    <div className="text-base font-semibold">{u.label}</div>
                    <div className="mt-1 text-xs text-black/50 dark:text-white/50">
                      {u.serviceChargeAmount
                        ? `Service charge: ${u.serviceChargeAmount.toLocaleString()}`
                        : "No service charge set"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
