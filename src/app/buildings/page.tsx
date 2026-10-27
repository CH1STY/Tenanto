import Link from "next/link";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { Charge } from "@/models/Charge";
import { getActiveBuildingId } from "@/lib/active-building";
import { CHARGE_CATEGORY, CHARGE_STATUS } from "@/lib/constants";
import { currentMonthYear, monthLabel } from "@/lib/dates";
import { setActiveBuilding } from "./actions";

export const metadata = { title: "Buildings — Tenant App" };

/** "2026-10" -> "Oct 2026". */
const shortMonth = (ym: string) => {
  const [name, year] = monthLabel(ym).split(" ");
  return year ? `${name.slice(0, 3)} ${year}` : ym;
};

type MonthStatus = {
  monthYear: string;
  paidTenants: number;
  chargedTenants: number;
  leftThisMonth: number;
};

/**
 * Per-building status for its "current" month (the real current month if it
 * has been opened, else the latest opened one — same rule as the building
 * page), in a fixed number of queries regardless of building count. A tenant
 * counts as paid when everything billed for that month is settled.
 */
async function loadMonthStatuses(): Promise<{
  byBuilding: Map<string, MonthStatus>;
  outstanding: Map<string, number>;
}> {
  const nowYm = currentMonthYear();
  const periodAgg = await MonthlyPeriod.aggregate<{
    _id: unknown;
    latest: string;
    hasNow: boolean;
  }>([
    {
      $group: {
        _id: "$buildingId",
        latest: { $max: "$monthYear" },
        hasNow: { $max: { $eq: ["$monthYear", nowYm] } },
      },
    },
  ]);
  const currentYm = new Map(
    periodAgg.map((p) => [String(p._id), p.hasNow ? nowYm : p.latest]),
  );
  const months = [...new Set(currentYm.values())];

  const [tenantAgg, outstandingAgg] = await Promise.all([
    months.length
      ? Charge.aggregate<{
          _id: { b: unknown; t: unknown; m: string };
          due: number;
          paid: number;
        }>([
          {
            $match: {
              monthYear: { $in: months },
              // Previous dues are old debt, not this month's bill.
              category: { $ne: CHARGE_CATEGORY.PREVIOUS_DUE },
            },
          },
          {
            $group: {
              _id: { b: "$buildingId", t: "$tenancyId", m: "$monthYear" },
              due: { $sum: "$amount" },
              paid: {
                $sum: {
                  $min: ["$amount", { $max: [0, { $ifNull: ["$paidAmount", 0] }] }],
                },
              },
            },
          },
        ])
      : Promise.resolve([]),
    Charge.aggregate<{ _id: unknown; s: number }>([
      { $match: { status: { $ne: CHARGE_STATUS.PAID } } },
      {
        $group: {
          _id: "$buildingId",
          s: {
            $sum: {
              $max: [
                0,
                { $subtract: ["$amount", { $ifNull: ["$paidAmount", 0] }] },
              ],
            },
          },
        },
      },
    ]),
  ]);

  const byBuilding = new Map<string, MonthStatus>();
  for (const [b, ym] of currentYm) {
    byBuilding.set(b, {
      monthYear: ym,
      paidTenants: 0,
      chargedTenants: 0,
      leftThisMonth: 0,
    });
  }
  for (const r of tenantAgg) {
    const st = byBuilding.get(String(r._id.b));
    // Only the building's own current month counts (months are batched).
    if (!st || st.monthYear !== r._id.m || r.due <= 0) continue;
    st.chargedTenants += 1;
    if (r.paid >= r.due) st.paidTenants += 1;
    st.leftThisMonth += r.due - r.paid;
  }

  return {
    byBuilding,
    outstanding: new Map(outstandingAgg.map((o) => [String(o._id), o.s])),
  };
}

export default async function BuildingsPage() {
  await connectDB();

  const [buildings, unitCounts, activeId, statuses] = await Promise.all([
    Building.find().sort({ name: 1 }).lean(),
    Unit.aggregate<{ _id: unknown; count: number }>([
      { $group: { _id: "$buildingId", count: { $sum: 1 } } },
    ]),
    getActiveBuildingId(),
    loadMonthStatuses(),
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
            const st = statuses.byBuilding.get(id);
            const totalOutstanding = statuses.outstanding.get(id) ?? 0;
            const allPaid =
              st && st.chargedTenants > 0 && st.paidTenants === st.chargedTenants;

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
                {st ? (
                  <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-xs">
                    <span
                      aria-hidden
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        st.chargedTenants === 0
                          ? "bg-black/30 dark:bg-white/40"
                          : allPaid
                            ? "bg-green-500"
                            : "bg-amber-500"
                      }`}
                    />
                    <span className="font-medium">{shortMonth(st.monthYear)}</span>
                    <span className="text-black/55 dark:text-white/55">
                      ·{" "}
                      {st.chargedTenants === 0
                        ? "nothing charged yet"
                        : `${st.paidTenants}/${st.chargedTenants} paid`}
                    </span>
                    {st.leftThisMonth > 0 ? (
                      <span className="font-medium text-red-600 dark:text-red-400">
                        · {st.leftThisMonth.toLocaleString()} due
                      </span>
                    ) : null}
                    {totalOutstanding > st.leftThisMonth ? (
                      <span className="text-black/55 dark:text-white/55">
                        · {totalOutstanding.toLocaleString()} total outstanding
                      </span>
                    ) : null}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-black/45 dark:text-white/45">
                    No month opened yet
                  </p>
                )}

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
