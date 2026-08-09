import Link from "next/link";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { getActiveBuildingId } from "@/lib/active-building";
import { setActiveBuilding } from "./actions";

export const metadata = { title: "Buildings — Tenant App" };

export default async function BuildingsPage() {
  await connectDB();

  const [buildings, unitCounts, activeId] = await Promise.all([
    Building.find().sort({ name: 1 }).lean(),
    Unit.aggregate<{ _id: unknown; count: number }>([
      { $group: { _id: "$buildingId", count: { $sum: 1 } } },
    ]),
    getActiveBuildingId(),
  ]);

  const countByBuilding = new Map(
    unitCounts.map((c) => [String(c._id), c.count]),
  );

  return (
    <div>
      <h1 className="text-2xl font-semibold">Buildings</h1>
      <p className="mt-1 text-sm text-black/55 dark:text-white/55">
        Pick a building to view its floors and units. Your choice is remembered
        as your active building until you pick another.
      </p>

      {buildings.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-black/15 p-10 text-center text-black/55 dark:border-white/20 dark:text-white/55">
          No buildings have been added yet.
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {buildings.map((b) => {
            const id = String(b._id);
            const isActive = activeId === id;
            const units = countByBuilding.get(id) ?? 0;

            return (
              <div
                key={id}
                className="flex flex-col rounded-lg border border-black/10 p-5 dark:border-white/15"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-base font-semibold">{b.name}</h2>
                  {isActive ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                      Active
                    </span>
                  ) : null}
                </div>
                {b.address ? (
                  <p className="mt-1 text-sm text-black/55 dark:text-white/55">
                    {b.address}
                  </p>
                ) : null}
                <p className="mt-3 text-xs text-black/50 dark:text-white/50">
                  {b.numberOfFloors} floor{b.numberOfFloors === 1 ? "" : "s"} ·{" "}
                  {units} unit{units === 1 ? "" : "s"}
                </p>

                <div className="mt-4 flex gap-2">
                  {isActive ? (
                    <Link
                      href={`/buildings/${id}`}
                      className="inline-flex h-9 flex-1 items-center justify-center rounded-md bg-foreground text-sm font-medium text-background hover:opacity-90"
                    >
                      View
                    </Link>
                  ) : (
                    <form action={setActiveBuilding} className="flex-1">
                      <input type="hidden" name="buildingId" value={id} />
                      <button
                        type="submit"
                        className="inline-flex h-9 w-full items-center justify-center rounded-md bg-foreground text-sm font-medium text-background hover:opacity-90"
                      >
                        Select &amp; view
                      </button>
                    </form>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
