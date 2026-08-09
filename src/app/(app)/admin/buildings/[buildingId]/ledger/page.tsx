import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/rbac";
import {
  ROLES,
  PERIOD_STATUS,
  CHARGE_CATEGORY,
  CHARGE_STATUS,
  EXPENSE_STATUS,
} from "@/lib/constants";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { User } from "@/models/User";
import { Tenancy } from "@/models/Tenancy";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { Charge } from "@/models/Charge";
import { Income } from "@/models/Income";
import { Expense } from "@/models/Expense";
import { Withdrawal } from "@/models/Withdrawal";
import { getPeriodTotals } from "@/lib/ledger";
import { objectIdSchema } from "@/lib/validators/building";
import { ConfirmSubmit } from "@/components/confirm-submit";
import {
  OpenMonthForm,
  PayForm,
  IncomeForm,
  ExpenseForm,
  WithdrawalForm,
} from "./forms";
import { closeMonth } from "./actions";

const money = (n: number) => n.toLocaleString();

function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m, 1); // m is 1-based; new Date month is 0-based => next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default async function LedgerPage(props: {
  params: Promise<{ buildingId: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== ROLES.SUPER_ADMIN) redirect("/dashboard");

  const { buildingId } = await props.params;
  if (!objectIdSchema.safeParse(buildingId).success) notFound();
  const { month } = await props.searchParams;

  await connectDB();
  const building = await Building.findById(buildingId).lean();
  if (!building) notFound();

  const periods = await MonthlyPeriod.find({ buildingId })
    .sort({ monthYear: -1 })
    .lean();

  const thisMonth = new Date().toISOString().slice(0, 7);
  const defaultNewMonth = periods[0]
    ? nextMonth(periods[0].monthYear)
    : thisMonth;

  // Selected month: query param, else latest period.
  const selectedMonth =
    month && /^\d{4}-\d{2}$/.test(month)
      ? month
      : (periods[0]?.monthYear ?? null);

  const period = selectedMonth
    ? periods.find((p) => p.monthYear === selectedMonth) ?? null
    : null;

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
          Cash book · {building.name}
        </h1>
      </div>

      {/* Month selector */}
      {periods.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {periods.map((p) => {
            const active = p.monthYear === selectedMonth;
            return (
              <Link
                key={p.monthYear}
                href={`/admin/buildings/${buildingId}/ledger?month=${p.monthYear}`}
                className={`inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm ${
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-black/15 hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
                }`}
              >
                {p.monthYear}
                <span
                  className={`text-xs ${
                    p.status === PERIOD_STATUS.CLOSED
                      ? "opacity-70"
                      : "text-green-600 dark:text-green-400"
                  }`}
                >
                  {p.status === PERIOD_STATUS.CLOSED ? "closed" : "open"}
                </span>
              </Link>
            );
          })}
        </div>
      ) : null}

      {/* Open a new month */}
      <section className="rounded-lg border border-black/10 p-5 dark:border-white/15">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Open a month
        </h2>
        <OpenMonthForm buildingId={buildingId} defaultMonth={defaultNewMonth} />
      </section>

      {period ? (
        <CashBook
          buildingId={buildingId}
          buildingName={building.name}
          period={period}
        />
      ) : periods.length === 0 ? (
        <p className="text-sm text-black/55 dark:text-white/55">
          No months opened yet. Open the first month above to start the cash book.
        </p>
      ) : null}
    </div>
  );
}

async function CashBook({
  buildingId,
  buildingName,
  period,
}: {
  buildingId: string;
  buildingName: string;
  period: {
    _id: unknown;
    monthYear: string;
    openingBalance: number;
    serviceChargeAmount: number;
    status: string;
    closingBalance?: number | null;
  };
}) {
  const monthYear = period.monthYear;
  const isOpen = period.status === PERIOD_STATUS.OPEN;

  const [tenancies, incomes, expenses, withdrawals, totals] = await Promise.all([
    Tenancy.find({ buildingId, isActive: true }).lean(),
    Income.find({ buildingId, monthYear }).sort({ createdAt: 1 }).lean(),
    Expense.find({ buildingId, monthYear }).sort({ voucherNo: 1 }).lean(),
    Withdrawal.find({ buildingId, monthYear }).sort({ createdAt: 1 }).lean(),
    getPeriodTotals(buildingId, monthYear),
  ]);

  const tenancyIds = tenancies.map((t) => t._id);
  const [units, users, charges] = await Promise.all([
    Unit.find({ buildingId }).lean(),
    User.find({ _id: { $in: tenancies.map((t) => t.userId) } }).lean(),
    Charge.find({ tenancyId: { $in: tenancyIds } })
      .sort({ monthYear: 1 })
      .lean(),
  ]);

  const unitLabel = new Map(units.map((u) => [String(u._id), u.label]));
  const userName = new Map(users.map((u) => [String(u._id), u.name]));

  // Charges to show per tenancy: this month's service charge + any outstanding.
  const chargesByTenancy = new Map<string, typeof charges>();
  for (const c of charges) {
    const isThisMonthSC =
      c.monthYear === monthYear &&
      c.category === CHARGE_CATEGORY.SERVICE_CHARGE;
    const isOutstanding = c.status !== CHARGE_STATUS.PAID;
    if (!isThisMonthSC && !isOutstanding) continue;
    const key = String(c.tenancyId);
    const list = chargesByTenancy.get(key) ?? [];
    list.push(c);
    chargesByTenancy.set(key, list);
  }

  const rows = tenancies
    .map((t) => ({
      tenancyId: String(t._id),
      unit: unitLabel.get(String(t.unitId)) ?? "?",
      name: userName.get(String(t.userId)) ?? "Tenant",
      charges: chargesByTenancy.get(String(t._id)) ?? [],
    }))
    .sort((a, b) => a.unit.localeCompare(b.unit));

  const totalReceipts = period.openingBalance + totals.payments + totals.income;
  const cashInHand = totalReceipts - totals.expensesPaid;
  const closing = cashInHand - totals.withdrawals;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          {buildingName} · {monthYear}
          <span
            className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${
              isOpen
                ? "bg-green-500/15 text-green-700 dark:text-green-400"
                : "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60"
            }`}
          >
            {isOpen ? "OPEN" : "CLOSED"}
          </span>
        </h2>
        {isOpen ? (
          <form action={closeMonth}>
            <input type="hidden" name="buildingId" value={buildingId} />
            <input type="hidden" name="monthYear" value={monthYear} />
            <ConfirmSubmit
              message={`Close ${monthYear}? Closing cash in hand will be ${money(
                closing
              )} and carried to the next month. This cannot be undone.`}
              className="inline-flex h-9 items-center justify-center rounded-md border border-black/15 px-4 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
            >
              Close month
            </ConfirmSubmit>
          </form>
        ) : null}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Receipts */}
        <section className="rounded-lg border border-black/10 dark:border-white/15">
          <header className="border-b border-black/10 px-4 py-3 text-sm font-semibold dark:border-white/15">
            Dr. — Receipts
          </header>
          <div className="divide-y divide-black/5 dark:divide-white/10">
            <Line label="Opening — cash in hand" amount={period.openingBalance} strong />

            {rows.map((r) => (
              <div key={r.tenancyId} className="px-4 py-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {r.unit} · {r.name}
                  </span>
                </div>
                {r.charges.length === 0 ? (
                  <p className="mt-1 text-xs text-black/45 dark:text-white/45">
                    No charges.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {r.charges.map((c) => {
                      const remaining = c.amount - c.paidAmount;
                      return (
                        <li key={String(c._id)} className="text-xs">
                          <div className="flex items-center justify-between">
                            <span className="text-black/70 dark:text-white/70">
                              {c.description}
                              {c.monthYear !== monthYear ? (
                                <span className="ml-1 text-black/40 dark:text-white/40">
                                  ({c.monthYear})
                                </span>
                              ) : null}
                            </span>
                            <span className="tabular-nums">
                              {money(c.paidAmount)}/{money(c.amount)}
                            </span>
                          </div>
                          {isOpen && remaining > 0 ? (
                            <PayForm
                              buildingId={buildingId}
                              monthYear={monthYear}
                              chargeId={String(c._id)}
                              remaining={remaining}
                            />
                          ) : c.status === CHARGE_STATUS.PAID ? (
                            <span className="text-green-600 dark:text-green-400">
                              Paid
                            </span>
                          ) : (
                            <span className="text-amber-600 dark:text-amber-400">
                              Due {money(remaining)}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}

            {/* Other income */}
            <div className="px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">
                Other income
              </p>
              {incomes.length === 0 ? (
                <p className="mt-1 text-xs text-black/45 dark:text-white/45">
                  None yet.
                </p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {incomes.map((i) => (
                    <li
                      key={String(i._id)}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-black/70 dark:text-white/70">
                        {i.description}{" "}
                        <span className="text-black/40 dark:text-white/40">
                          ({i.source})
                        </span>
                      </span>
                      <span className="tabular-nums">{money(i.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {isOpen ? (
                <div className="mt-3">
                  <IncomeForm buildingId={buildingId} monthYear={monthYear} />
                </div>
              ) : null}
            </div>

            <Line label="Total receipts (incl. opening)" amount={totalReceipts} strong />
          </div>
        </section>

        {/* Payments / Expenses */}
        <section className="rounded-lg border border-black/10 dark:border-white/15">
          <header className="border-b border-black/10 px-4 py-3 text-sm font-semibold dark:border-white/15">
            Cr. — Payments / Expenses
          </header>
          <div className="divide-y divide-black/5 dark:divide-white/10">
            <div className="px-4 py-3">
              {expenses.length === 0 ? (
                <p className="text-xs text-black/45 dark:text-white/45">
                  No expenses yet.
                </p>
              ) : (
                <ul className="space-y-1">
                  {expenses.map((e) => (
                    <li
                      key={String(e._id)}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-black/70 dark:text-white/70">
                        <span className="text-black/40 dark:text-white/40">
                          V#{e.voucherNo}
                        </span>{" "}
                        {e.description}
                        {e.status === EXPENSE_STATUS.DUE ? (
                          <span className="ml-1 text-amber-600 dark:text-amber-400">
                            DUE
                          </span>
                        ) : null}
                      </span>
                      <span className="tabular-nums">{money(e.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {isOpen ? (
                <div className="mt-3">
                  <ExpenseForm buildingId={buildingId} monthYear={monthYear} />
                </div>
              ) : null}
            </div>

            <Line
              label="Total expenses (paid)"
              amount={totals.expensesPaid}
              strong
            />
            <Line label="Cash in hand" amount={cashInHand} strong />

            <div className="px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">
                Withdrawals
              </p>
              {withdrawals.length === 0 ? (
                <p className="mt-1 text-xs text-black/45 dark:text-white/45">
                  None.
                </p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {withdrawals.map((w) => (
                    <li
                      key={String(w._id)}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-black/70 dark:text-white/70">
                        {w.takenBy}
                        {w.note ? (
                          <span className="text-black/40 dark:text-white/40">
                            {" "}
                            · {w.note}
                          </span>
                        ) : null}
                      </span>
                      <span className="tabular-nums">{money(w.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {isOpen ? (
                <div className="mt-3">
                  <WithdrawalForm buildingId={buildingId} monthYear={monthYear} />
                </div>
              ) : null}
            </div>

            <Line label="− Withdrawals" amount={totals.withdrawals} />
            <Line
              label={
                period.status === PERIOD_STATUS.CLOSED
                  ? "Closing cash in hand (carried forward)"
                  : "Closing cash in hand (projected)"
              }
              amount={
                period.closingBalance != null ? period.closingBalance : closing
              }
              strong
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function Line({
  label,
  amount,
  strong,
}: {
  label: string;
  amount: number;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span
        className={`text-sm ${
          strong ? "font-semibold" : "text-black/70 dark:text-white/70"
        }`}
      >
        {label}
      </span>
      <span className={`tabular-nums ${strong ? "font-semibold" : ""}`}>
        {money(amount)}
      </span>
    </div>
  );
}
