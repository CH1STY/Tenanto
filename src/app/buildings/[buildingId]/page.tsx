import Link from "next/link";
import { notFound } from "next/navigation";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { User } from "@/models/User";
import { Tenancy } from "@/models/Tenancy";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { Charge } from "@/models/Charge";
import { getActiveBuildingId } from "@/lib/active-building";
import { userManagesBuilding } from "@/lib/rbac";
import { objectIdSchema } from "@/lib/validators/building";
import { CHARGE_CATEGORY, CHARGE_STATUS } from "@/lib/constants";
import { monthLabel, currentMonthYear } from "@/lib/dates";
import { compareUnitLabels } from "@/lib/units";
import { setActiveBuilding } from "../actions";
import { MonthlyCashBook } from "./cashbook";
import { loadCashBook } from "./cashbook-actions";

const money = (n: number) => n.toLocaleString();

export default async function BuildingDetailPage(props: {
  params: Promise<{ buildingId: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { buildingId } = await props.params;
  if (!objectIdSchema.safeParse(buildingId).success) notFound();
  const { month } = await props.searchParams;

  await connectDB();

  const [building, units, activeId, periods] = await Promise.all([
    Building.findById(buildingId).lean(),
    Unit.find({ buildingId }).sort({ floorNumber: 1, label: 1 }).lean(),
    getActiveBuildingId(),
    MonthlyPeriod.find({ buildingId }).sort({ monthYear: -1 }).lean(),
  ]);

  if (!building) notFound();

  const isActive = activeId === buildingId;
  const canManage = await userManagesBuilding(buildingId);

  // Cash book month: query param, else the latest opened period.
  const selectedMonth =
    month && /^\d{4}-\d{2}$/.test(month)
      ? month
      : (periods[0]?.monthYear ?? null);
  const initialCashBook = selectedMonth
    ? await loadCashBook(buildingId, selectedMonth)
    : null;

  // "Current" month = the real current month if opened, otherwise the latest.
  const nowYm = currentMonthYear();
  const currentPeriod =
    periods.find((p) => p.monthYear === nowYm) ?? periods[0] ?? null;

  // Active tenants + names + all their charges, for status and dues.
  const tenancies = await Tenancy.find({ buildingId, isActive: true }).lean();
  const [users, allCharges] = await Promise.all([
    User.find({ _id: { $in: tenancies.map((t) => t.userId) } }).lean(),
    Charge.find({ tenancyId: { $in: tenancies.map((t) => t._id) } })
      .sort({ monthYear: 1 })
      .lean(),
  ]);
  const unitLabel = new Map(units.map((u) => [String(u._id), u.label]));
  const userName = new Map(users.map((u) => [String(u._id), u.name]));

  // Service-charge status for the current month, one row per active tenant.
  const scStatus = tenancies
    .map((t) => {
      const sc = currentPeriod
        ? allCharges.find(
            (c) =>
              String(c.tenancyId) === String(t._id) &&
              c.monthYear === currentPeriod.monthYear &&
              c.category === CHARGE_CATEGORY.SERVICE_CHARGE,
          )
        : undefined;
      return {
        unit: unitLabel.get(String(t.unitId)) ?? "?",
        name: userName.get(String(t.userId)) ?? "Tenant",
        sc,
      };
    })
    .sort((a, b) => compareUnitLabels(a.unit, b.unit));

  // Outstanding dues (any month, any category), grouped per tenant.
  const duesByTenancy = new Map<
    string,
    { unit: string; name: string; total: number; items: typeof allCharges }
  >();
  for (const c of allCharges) {
    if (c.status === CHARGE_STATUS.PAID) continue;
    const t = tenancies.find((x) => String(x._id) === String(c.tenancyId));
    if (!t) continue;
    const key = String(t._id);
    const entry = duesByTenancy.get(key) ?? {
      unit: unitLabel.get(String(t.unitId)) ?? "?",
      name: userName.get(String(t.userId)) ?? "Tenant",
      total: 0,
      items: [] as typeof allCharges,
    };
    entry.total += c.amount - c.paidAmount;
    entry.items.push(c);
    duesByTenancy.set(key, entry);
  }
  const dueRows = [...duesByTenancy.values()].sort((a, b) =>
    compareUnitLabels(a.unit, b.unit),
  );
  const totalDue = dueRows.reduce((s, r) => s + r.total, 0);

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
        className="no-print text-sm text-black/55 hover:text-foreground dark:text-white/55"
      >
        ← All buildings
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3 no-print">
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

        <div className="flex flex-col items-end gap-2">
          {canManage ? (
            <Link
              href={`/admin/buildings/${buildingId}`}
              className="inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90"
            >
              Manage building
            </Link>
          ) : null}
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
      </div>

      {/* Service charge status — current month */}
      <section className="mt-8 no-print">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
            Service charge
          </h2>
          {currentPeriod ? (
            <span className="text-xs text-black/50 dark:text-white/50">
              {monthLabel(currentPeriod.monthYear)}
            </span>
          ) : null}
        </div>

        {!currentPeriod ? (
          <p className="mt-3 text-sm text-black/55 dark:text-white/55">
            No month has been opened yet.
          </p>
        ) : scStatus.length === 0 ? (
          <p className="mt-3 text-sm text-black/55 dark:text-white/55">
            No active tenants.
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {scStatus.map((r) => {
              const remaining = r.sc ? r.sc.amount - r.sc.paidAmount : 0;
              const state = !r.sc
                ? {
                    label: "Not charged",
                    cls: "text-black/45 dark:text-white/45",
                  }
                : r.sc.status === CHARGE_STATUS.PAID
                  ? { label: "Paid", cls: "text-green-600 dark:text-green-400" }
                  : r.sc.status === CHARGE_STATUS.PARTIAL
                    ? {
                        label: `Partial · ${money(remaining)} left`,
                        cls: "text-red-600 dark:text-red-400",
                      }
                    : {
                        label: `Due ${money(remaining)}`,
                        cls: "text-red-600 dark:text-red-400",
                      };
              return (
                <div
                  key={`${r.unit}-${r.name}`}
                  className="flex items-center justify-between rounded-lg border border-black/10 px-4 py-3 dark:border-white/15"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {r.unit} · {r.name}
                    </div>
                    {r.sc ? (
                      <div className="mt-0.5 text-xs text-black/50 dark:text-white/50">
                        Total {money(r.sc.amount)}
                        {r.sc.paidAmount > 0
                          ? ` · Paid ${money(r.sc.paidAmount)}`
                          : ""}
                      </div>
                    ) : null}
                  </div>
                  <span className={`shrink-0 text-xs font-medium ${state.cls}`}>
                    {state.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Outstanding dues */}
      <section className="mt-8 no-print">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
            Outstanding dues
          </h2>
          {totalDue > 0 ? (
            <span className="text-xs font-medium text-red-600 dark:text-red-400">
              Total {money(totalDue)}
            </span>
          ) : null}
        </div>

        {dueRows.length === 0 ? (
          <p className="mt-3 text-sm text-black/55 dark:text-white/55">
            No outstanding dues. Everyone is up to date.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {dueRows.map((r) => (
              <div
                key={`${r.unit}-${r.name}`}
                className="rounded-lg border border-black/10 p-4 dark:border-white/15"
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {r.unit} · {r.name}
                  </span>
                  <span className="font-semibold tabular-nums text-red-600 dark:text-red-400">
                    {money(r.total)}
                  </span>
                </div>
                <ul className="mt-2 space-y-1">
                  {r.items.map((c) => (
                    <li
                      key={String(c._id)}
                      className="flex items-center justify-between text-xs text-black/60 dark:text-white/60"
                    >
                      <span>
                        {c.description}{" "}
                        <span className="text-black/40 dark:text-white/40">
                          ({monthLabel(c.monthYear)})
                        </span>
                      </span>
                      <span className="tabular-nums text-red-600 dark:text-red-400">
                        {money(c.amount - c.paidAmount)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Monthwise cash book */}
      <section className="mt-8">
        <h2 className="no-print text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Cash book
        </h2>

        {periods.length === 0 ? (
          <p className="mt-3 text-sm text-black/55 dark:text-white/55">
            No months have been opened yet.
          </p>
        ) : (
          <MonthlyCashBook
            buildingId={buildingId}
            periods={periods.map((p) => ({
              monthYear: p.monthYear,
              status: p.status,
            }))}
            initialMonth={selectedMonth ?? ""}
            initialData={initialCashBook}
          />
        )}
      </section>

      <div className="no-print">
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
    </div>
  );
}
