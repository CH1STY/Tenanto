import Link from "next/link";
import { notFound } from "next/navigation";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { User } from "@/models/User";
import { Tenancy } from "@/models/Tenancy";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { Charge } from "@/models/Charge";
import { Expense } from "@/models/Expense";
import { Withdrawal } from "@/models/Withdrawal";
import { getActiveBuildingId } from "@/lib/active-building";
import { userManagesBuilding } from "@/lib/rbac";
import { objectIdSchema } from "@/lib/validators/building";
import {
  CHARGE_CATEGORY,
  CHARGE_STATUS,
  EXPENSE_STATUS,
  PERIOD_STATUS,
} from "@/lib/constants";
import { monthLabel, currentMonthYear } from "@/lib/dates";
import { compareUnitLabels } from "@/lib/units";
import { setActiveBuilding } from "../actions";
import { MonthlyCashBook } from "./cashbook";
import { loadCashBook } from "./cashbook-actions";
import {
  MonthSummary,
  WhoPaidBoard,
  type BoardRow,
  type PayState,
} from "./status-board";

const money = (n: number) => n.toLocaleString();

// Collapsible secondary sections so the page leads with the month's status.
const SECTION = "mt-8 no-print";
const SUMMARY =
  "flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-2 rounded-md py-1 [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-offset-2";
const H2 =
  "inline-flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50";
function Chevron() {
  return (
    <span
      aria-hidden
      className="inline-block text-xs transition-transform group-open:rotate-90"
    >
      ▸
    </span>
  );
}

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

  // All tenancies (active + past) so a detached tenant's unpaid dues still show.
  const tenancies = await Tenancy.find({ buildingId }).lean();
  const activeTenancies = tenancies.filter((t) => t.isActive);
  const [users, allCharges, allExpenses, allWithdrawals] = await Promise.all([
    User.find({ _id: { $in: tenancies.map((t) => t.userId) } }).lean(),
    Charge.find({ tenancyId: { $in: tenancies.map((t) => t._id) } })
      .sort({ monthYear: 1 })
      .lean(),
    Expense.find({ buildingId }).sort({ monthYear: 1, voucherNo: 1 }).lean(),
    Withdrawal.find({ buildingId }).sort({ monthYear: 1, takenAt: 1 }).lean(),
  ]);
  const unitLabel = new Map(units.map((u) => [String(u._id), u.label]));
  const userName = new Map(users.map((u) => [String(u._id), u.name]));

  const tenancyById = new Map(tenancies.map((t) => [String(t._id), t]));
  const chargesByTenancy = new Map<string, typeof allCharges>();
  for (const c of allCharges) {
    const k = String(c.tenancyId);
    const list = chargesByTenancy.get(k) ?? [];
    list.push(c);
    chargesByTenancy.set(k, list);
  }

  // "Who has paid" for the current month. A tenant's status for the month is
  // based on the charges billed for that month (service charge, bills, other)
  // — not the service charge alone — so "Paid" means nothing billed this month
  // is left. Previous dues (old debt recorded in any month) and unpaid charges
  // from other months are shown separately as arrears. Rows: every active tenancy, plus
  // any past tenancy that was charged this month.
  const curYm = currentPeriod?.monthYear ?? null;
  const boardTenancies = curYm
    ? tenancies.filter(
        (t) =>
          t.isActive ||
          (chargesByTenancy.get(String(t._id)) ?? []).some(
            (c) =>
              c.monthYear === curYm &&
              c.category !== CHARGE_CATEGORY.PREVIOUS_DUE,
          ),
      )
    : activeTenancies;
  const boardRows: BoardRow[] = boardTenancies
    .map((t) => {
      const charges = chargesByTenancy.get(String(t._id)) ?? [];
      const isThisMonth = (c: (typeof charges)[number]) =>
        c.monthYear === curYm && c.category !== CHARGE_CATEGORY.PREVIOUS_DUE;
      const month = curYm ? charges.filter(isThisMonth) : [];
      const due = month.reduce((s, c) => s + c.amount, 0);
      const paid = month.reduce(
        (s, c) => s + Math.min(c.amount, Math.max(0, c.paidAmount)),
        0,
      );
      const arrears = charges
        .filter((c) => !isThisMonth(c) && c.status !== CHARGE_STATUS.PAID)
        .reduce((s, c) => s + Math.max(0, c.amount - c.paidAmount), 0);
      const state: PayState =
        due <= 0
          ? "NONE"
          : paid >= due
            ? "PAID"
            : paid > 0
              ? "PARTIAL"
              : "UNPAID";
      return {
        key: String(t._id),
        unit: unitLabel.get(String(t.unitId)) ?? "?",
        name: userName.get(String(t.userId)) ?? "Tenant",
        isPastTenant: !t.isActive,
        due,
        paid,
        state,
        arrears,
        breakdown: month.map((c) => ({
          id: String(c._id),
          description:
            c.category === CHARGE_CATEGORY.SERVICE_CHARGE
              ? "Service charge"
              : c.description,
          amount: c.amount,
          paid: Math.min(c.amount, Math.max(0, c.paidAmount)),
        })),
      };
    })
    .sort((a, b) => compareUnitLabels(a.unit, b.unit));
  const stateCounts: Record<PayState, number> = {
    PAID: 0,
    PARTIAL: 0,
    UNPAID: 0,
    NONE: 0,
  };
  for (const r of boardRows) stateCounts[r.state] += 1;
  const monthBilled = boardRows.reduce((s, r) => s + r.due, 0);
  const monthCollected = boardRows.reduce((s, r) => s + r.paid, 0);

  // Outstanding dues (any month, any category), grouped per tenant — including
  // tenants who have since detached but still owe money.
  const duesByTenancy = new Map<
    string,
    {
      unit: string;
      name: string;
      isPastTenant: boolean;
      total: number;
      items: typeof allCharges;
    }
  >();
  for (const c of allCharges) {
    if (c.status === CHARGE_STATUS.PAID) continue;
    const t = tenancyById.get(String(c.tenancyId));
    if (!t) continue;
    const key = String(t._id);
    const entry = duesByTenancy.get(key) ?? {
      unit: unitLabel.get(String(t.unitId)) ?? "?",
      name: userName.get(String(t.userId)) ?? "Tenant",
      isPastTenant: !t.isActive,
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

  // Outstanding building expenses (payables not fully settled) + their history.
  const dueExpenses = allExpenses
    .filter(
      (e) => e.status !== EXPENSE_STATUS.PAID && e.amount - e.paidAmount > 0,
    )
    .map((e) => ({
      id: String(e._id),
      voucherNo: e.voucherNo,
      description: e.description,
      monthYear: e.monthYear,
      amount: e.amount,
      paidAmount: e.paidAmount,
      outstanding: e.amount - e.paidAmount,
      payments: (e.payments ?? []).map((p) => ({
        amount: p.amount,
        monthYear: p.monthYear,
      })),
    }));
  const totalDueExpenses = dueExpenses.reduce((s, e) => s + e.outstanding, 0);

  // All withdrawals with their repayment (return) history.
  const withdrawalRows = allWithdrawals.map((w) => ({
    id: String(w._id),
    takenBy: w.takenBy,
    note: w.note ?? null,
    monthYear: w.monthYear,
    amount: w.amount,
    returnedAmount: w.returnedAmount,
    outstanding: w.amount - w.returnedAmount,
    returns: (w.returns ?? []).map((r) => ({
      amount: r.amount,
      monthYear: r.monthYear,
    })),
  }));
  const totalWithdrawn = withdrawalRows.reduce((s, w) => s + w.amount, 0);
  const totalWithdrawalOutstanding = withdrawalRows.reduce(
    (s, w) => s + w.outstanding,
    0,
  );

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

        <div className="flex flex-col items-start gap-2 sm:items-end">
          {canManage ? (
            <div className="flex gap-2">
              <Link
                href={`/admin/buildings/${buildingId}/ledger`}
                className="inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90"
              >
                Edit cash book
              </Link>
              <Link
                href={`/admin/buildings/${buildingId}/tenants`}
                className="inline-flex h-9 items-center justify-center rounded-md border border-black/15 px-4 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
              >
                Tenants
              </Link>
            </div>
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

      {/* Current month at a glance */}
      {currentPeriod ? (
        <>
          <MonthSummary
            monthName={monthLabel(currentPeriod.monthYear)}
            isClosed={currentPeriod.status === PERIOD_STATUS.CLOSED}
            fallbackNote={
              currentPeriod.monthYear !== nowYm
                ? `${monthLabel(nowYm)} hasn't been opened yet — showing the latest month.`
                : null
            }
            collected={monthCollected}
            billed={monthBilled}
            counts={stateCounts}
            totalOutstanding={totalDue}
          />
          <WhoPaidBoard
            monthName={monthLabel(currentPeriod.monthYear)}
            rows={boardRows}
          />
        </>
      ) : (
        <section className="mt-6 rounded-xl border border-dashed border-black/15 p-5 text-sm text-black/55 dark:border-white/20 dark:text-white/55 no-print">
          No month has been opened yet, so there is no payment status to show.
          {totalDue > 0 ? (
            <span className="mt-1 block font-medium text-red-600 dark:text-red-400">
              Total outstanding dues: {money(totalDue)}
            </span>
          ) : null}
        </section>
      )}

      {/* Outstanding dues */}
      <details className={`${SECTION} group`}>
        <summary className={SUMMARY}>
          <h2 className={H2}>
            <Chevron />
            Outstanding dues
            {dueRows.length > 0 ? (
              <span className="ml-1 normal-case tracking-normal">
                ({dueRows.length} tenant{dueRows.length === 1 ? "" : "s"})
              </span>
            ) : null}
          </h2>
          {totalDue > 0 ? (
            <span className="text-xs font-medium text-red-600 dark:text-red-400">
              Total {money(totalDue)}
            </span>
          ) : (
            <span className="text-xs text-green-700 dark:text-green-400">
              All clear
            </span>
          )}
        </summary>

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
                    {r.isPastTenant ? (
                      <span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-black/45 dark:text-white/45">
                        (Past tenant)
                      </span>
                    ) : null}
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
      </details>

      {/* Due expenses (building payables) */}
      <details className={`${SECTION} group`}>
        <summary className={SUMMARY}>
          <h2 className={H2}>
            <Chevron />
            Due expenses
          </h2>
          {totalDueExpenses > 0 ? (
            <span className="text-xs font-medium text-red-600 dark:text-red-400">
              Total {money(totalDueExpenses)}
            </span>
          ) : null}
        </summary>

        {dueExpenses.length === 0 ? (
          <p className="mt-3 text-sm text-black/55 dark:text-white/55">
            No due expenses. All payables are settled.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {dueExpenses.map((e) => (
              <div
                key={e.id}
                className="rounded-lg border border-black/10 p-4 dark:border-white/15"
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {e.description}{" "}
                    <span className="text-black/40 dark:text-white/40">
                      (V#{e.voucherNo} · {monthLabel(e.monthYear)})
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums text-red-600 dark:text-red-400">
                    {money(e.outstanding)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-black/50 dark:text-white/50">
                  Total {money(e.amount)}
                  {e.paidAmount > 0 ? ` · Paid ${money(e.paidAmount)}` : ""}
                </div>
                {e.payments.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {e.payments.map((p, i) => (
                      <li
                        key={i}
                        className="flex items-center justify-between text-xs text-black/60 dark:text-white/60"
                      >
                        <span className="text-black/40 dark:text-white/40">
                          Paid ({monthLabel(p.monthYear)})
                        </span>
                        <span className="tabular-nums text-green-600 dark:text-green-400">
                          {money(p.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </details>

      {/* Withdrawals + repayment history */}
      <details className={`${SECTION} group`}>
        <summary className={SUMMARY}>
          <h2 className={H2}>
            <Chevron />
            Withdrawals
          </h2>
          {totalWithdrawn > 0 ? (
            <span className="text-xs text-black/50 dark:text-white/50">
              Withdrawn {money(totalWithdrawn)}
              {totalWithdrawalOutstanding > 0 ? (
                <span className="ml-1 font-medium text-red-600 dark:text-red-400">
                  · Pending {money(totalWithdrawalOutstanding)}
                </span>
              ) : null}
            </span>
          ) : null}
        </summary>

        {withdrawalRows.length === 0 ? (
          <p className="mt-3 text-sm text-black/55 dark:text-white/55">
            No withdrawals recorded.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {withdrawalRows.map((w) => (
              <div
                key={w.id}
                className="rounded-lg border border-black/10 p-4 dark:border-white/15"
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {w.takenBy}{" "}
                    <span className="text-black/40 dark:text-white/40">
                      ({monthLabel(w.monthYear)})
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums">
                    {money(w.amount)}
                  </span>
                </div>
                <div className="mt-1 text-xs">
                  {w.outstanding > 0 ? (
                    <span className="text-red-600 dark:text-red-400">
                      Pending {money(w.outstanding)}
                    </span>
                  ) : (
                    <span className="text-green-600 dark:text-green-400">
                      Fully returned
                    </span>
                  )}
                  {w.note ? (
                    <span className="text-black/50 dark:text-white/50">
                      {" · "}
                      {w.note}
                    </span>
                  ) : null}
                </div>
                {w.returns.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {w.returns.map((r, i) => (
                      <li
                        key={i}
                        className="flex items-center justify-between text-xs text-black/60 dark:text-white/60"
                      >
                        <span className="text-black/40 dark:text-white/40">
                          Returned ({monthLabel(r.monthYear)})
                        </span>
                        <span className="tabular-nums text-green-600 dark:text-green-400">
                          {money(r.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </details>

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

      <details className={`${SECTION} group`}>
        <summary className={SUMMARY}>
          <h2 className={H2}>
            <Chevron />
            Floors &amp; units
          </h2>
          <span className="text-xs text-black/50 dark:text-white/50">
            {units.length} unit{units.length === 1 ? "" : "s"}
          </span>
        </summary>

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
      </details>
    </div>
  );
}
