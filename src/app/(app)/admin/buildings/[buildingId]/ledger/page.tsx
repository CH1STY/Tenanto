import { Fragment } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, userManagesBuilding } from "@/lib/rbac";
import {
  ROLES,
  PERIOD_STATUS,
  CHARGE_CATEGORY,
  CHARGE_STATUS,
  EXPENSE_STATUS,
} from "@/lib/constants";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { Charge } from "@/models/Charge";
import { Income } from "@/models/Income";
import { Expense } from "@/models/Expense";
import { Withdrawal } from "@/models/Withdrawal";
import { Payment } from "@/models/Payment";
import {
  getPeriodTotals,
  resolveMonthRoster,
  paidByChargeAsOf,
  chargeStateAsOf,
  expenseMonthQuery,
  withdrawalMonthQuery,
  expensePaidAsOf,
  withdrawalReturnedAsOf,
} from "@/lib/ledger";
import { monthLabel, currentMonthYear, cashbookFileName } from "@/lib/dates";
import { compareUnitLabels } from "@/lib/units";
import { objectIdSchema } from "@/lib/validators/building";
import { ConfirmSubmit } from "@/components/confirm-submit";
import {
  OpenMonthForm,
  PayForm,
  IncomeForm,
  ExpenseForm,
  WithdrawalForm,
  AddChargeForm,
  EditChargeForm,
  MonthNoteForm,
  OpeningBalanceForm,
  ExpensePayForm,
  WithdrawalReturnForm,
  EntryDeleteButton,
  EntryUndoButton,
  PrintButton,
} from "./forms";
import {
  closeMonth,
  reopenMonth,
  deleteMonth,
  deleteIncome,
  deleteExpense,
  deleteWithdrawal,
  reversePayment,
  reverseExpensePayment,
  reverseWithdrawalReturn,
} from "./actions";

const money = (n: number) => n.toLocaleString();
const shortDate = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

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

  const { buildingId } = await props.params;
  if (!objectIdSchema.safeParse(buildingId).success) notFound();
  if (!(await userManagesBuilding(buildingId, user))) redirect("/dashboard");
  const { month } = await props.searchParams;

  await connectDB();
  const building = await Building.findById(buildingId).lean();
  if (!building) notFound();

  const periods = await MonthlyPeriod.find({ buildingId })
    .sort({ monthYear: -1 })
    .lean();

  const openPeriod =
    periods.find((p) => p.status === PERIOD_STATUS.OPEN) ?? null;
  const hasOpenMonth = openPeriod !== null;
  const canManageMonths = user.role === ROLES.SUPER_ADMIN;

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
    ? (periods.find((p) => p.monthYear === selectedMonth) ?? null)
    : null;

  return (
    <>
      <div className="space-y-8 no-print">
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
                  {monthLabel(p.monthYear)}
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
          {!canManageMonths ? (
            <p className="text-sm text-black/55 dark:text-white/55">
              Only a Super Admin can open or close a month.
            </p>
          ) : hasOpenMonth ? (
            <p className="text-sm text-black/55 dark:text-white/55">
              {monthLabel(openPeriod!.monthYear)} is open. Close it before
              opening or reopening another month — only one month can be open at
              a time.
            </p>
          ) : (
            <OpenMonthForm
              buildingId={buildingId}
              defaultMonth={defaultNewMonth}
            />
          )}
        </section>

        {period ? (
          <CashBook
            buildingId={buildingId}
            buildingName={building.name}
            period={period}
            canReopen={!hasOpenMonth}
            canManageMonths={canManageMonths}
            canAdjustPreviousDue={canManageMonths}
          />
        ) : periods.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">
            No months opened yet. Open the first month above to start the cash
            book.
          </p>
        ) : null}
      </div>

      {period ? (
        <PrintCashBook
          buildingId={buildingId}
          buildingName={building.name}
          buildingAddress={building.address ?? null}
          period={period}
        />
      ) : null}
    </>
  );
}

async function CashBook({
  buildingId,
  buildingName,
  period,
  canReopen,
  canManageMonths,
  canAdjustPreviousDue,
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
    note?: string | null;
    roster?: {
      tenancyId: unknown;
      userId: unknown;
      unitId: unknown;
      unitLabel?: string | null;
      tenantName?: string | null;
    }[];
  };
  canReopen: boolean;
  canManageMonths: boolean;
  canAdjustPreviousDue: boolean;
}) {
  const monthYear = period.monthYear;
  const isOpen = period.status === PERIOD_STATUS.OPEN;

  const [
    roster,
    incomes,
    rawExpenses,
    rawWithdrawals,
    payments,
    totals,
    prevPeriod,
  ] = await Promise.all([
    // A month's roster is the immutable snapshot taken when it opened; older
    // months without a snapshot fall back to tenancy date ranges. On an open
    // month also include past tenants who still owe so their dues stay
    // collectable and carry forward.
    resolveMonthRoster(buildingId, monthYear, period.roster, {
      includeOutstanding: isOpen,
    }),
    Income.find({ buildingId, monthYear }).sort({ createdAt: 1 }).lean(),
    // Carried payables still owed as of this month join this month's expenses.
    Expense.find(expenseMonthQuery(buildingId, monthYear))
      .sort({ monthYear: 1, voucherNo: 1 })
      .lean(),
    // Advances still out as of this month forward until fully returned.
    Withdrawal.find(withdrawalMonthQuery(buildingId, monthYear))
      .sort({ monthYear: 1, createdAt: 1 })
      .lean(),
    Payment.find({ buildingId, monthYear }).sort({ createdAt: 1 }).lean(),
    getPeriodTotals(buildingId, monthYear),
    MonthlyPeriod.findOne({ buildingId, monthYear: { $lt: monthYear } })
      .sort({ monthYear: -1 })
      .select("monthYear note")
      .lean(),
  ]);

  // Settle expenses/withdrawals only with log entries up to this month, so a
  // payable cleared later still reads as owed here and legacy paid rows aren't
  // dragged forward as dues.
  const expenses = rawExpenses.map((e) => ({
    ...e,
    paidAmount: expensePaidAsOf(e, monthYear),
  }));
  const withdrawals = rawWithdrawals.map((w) => ({
    ...w,
    returnedAmount: withdrawalReturnedAsOf(w, monthYear),
  }));

  const prevNote = prevPeriod?.note?.trim() ? prevPeriod.note.trim() : null;
  const prevNoteMonth = prevPeriod?.monthYear ?? null;
  const hasPreviousPeriod = Boolean(prevPeriod);

  const tenancyIds = roster.map((r) => r.tenancyId);
  // This month's and earlier charges only — a later month's dues must never
  // leak into a reopened past cash book.
  const rawCharges = await Charge.find({
    tenancyId: { $in: tenancyIds },
    monthYear: { $lte: monthYear },
  })
    .sort({ monthYear: 1 })
    .lean();

  // Show each charge as it stood in THIS month: settle it only with payments
  // received up to and including this month, so a due paid in a later month
  // still reads as outstanding here instead of being back-dated as paid.
  const paidAsOf = await paidByChargeAsOf(buildingId, monthYear);
  const charges = rawCharges.map((c) => {
    const state = chargeStateAsOf(c.amount, paidAsOf.get(String(c._id)) ?? 0);
    return { ...c, paidAmount: state.paidAmount, status: state.status };
  });

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

  // Total outstanding due per tenancy across all unpaid charges (any month).
  const dueByTenancy = new Map<string, number>();
  for (const c of charges) {
    if (c.status === CHARGE_STATUS.PAID) continue;
    const key = String(c.tenancyId);
    dueByTenancy.set(
      key,
      (dueByTenancy.get(key) ?? 0) + (c.amount - c.paidAmount),
    );
  }

  // Payments received this month, grouped by tenancy.
  const paymentsByTenancy = new Map<string, typeof payments>();
  for (const p of payments) {
    const key = String(p.tenancyId);
    const list = paymentsByTenancy.get(key) ?? [];
    list.push(p);
    paymentsByTenancy.set(key, list);
  }

  const rows = roster
    .map((r) => ({
      tenancyId: r.tenancyId,
      unit: r.unitLabel,
      name: r.tenantName,
      isPastTenant: r.isPastForMonth,
      charges: chargesByTenancy.get(r.tenancyId) ?? [],
      payments: paymentsByTenancy.get(r.tenancyId) ?? [],
      due: dueByTenancy.get(r.tenancyId) ?? 0,
    }))
    .sort((a, b) => compareUnitLabels(a.unit, b.unit));

  // Active tenants render in the main receipts list; past tenants with a
  // pending due appear in their own section so the two never mix.
  const activeRows = rows.filter((r) => !r.isPastTenant);
  const pastDueRows = rows.filter((r) => r.isPastTenant && r.due > 0);

  const tenantOptions = activeRows.map((r) => ({
    tenancyId: r.tenancyId,
    label: `${r.unit} · ${r.name}`,
  }));

  const renderReceiptRow = (r: (typeof rows)[number]) => (
    <div key={r.tenancyId} className="print-avoid-break px-4 py-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">
          {r.unit} · {r.name}
          {r.isPastTenant ? (
            <span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-black/45 dark:text-white/45">
              (Past tenant)
            </span>
          ) : null}
        </span>
        <span
          className={
            r.due > 0
              ? "text-xs font-medium text-red-600 dark:text-red-400"
              : "text-xs text-black/40 dark:text-white/40"
          }
        >
          {r.due > 0 ? `Due ${money(r.due)}` : "No due"}
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
                <div className="flex items-center justify-between gap-2">
                  <span className="text-black/70 dark:text-white/70">
                    {c.description}
                    {c.monthYear !== monthYear ? (
                      <span className="ml-1 text-black/40 dark:text-white/40">
                        ({monthLabel(c.monthYear)})
                      </span>
                    ) : null}
                  </span>
                  {remaining > 0 ? (
                    <span className="shrink-0 tabular-nums font-medium text-red-600 dark:text-red-400">
                      Due {money(remaining)}
                    </span>
                  ) : (
                    <span className="shrink-0 text-green-600 dark:text-green-400">
                      Paid
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-black/45 dark:text-white/45">
                  Total {money(c.amount)}
                  {c.paidAmount > 0 ? ` · Paid ${money(c.paidAmount)}` : ""}
                </div>
                {isOpen && remaining > 0 ? (
                  <PayForm
                    buildingId={buildingId}
                    monthYear={monthYear}
                    chargeId={String(c._id)}
                    remaining={remaining}
                  />
                ) : null}
                {isOpen &&
                c.category !== CHARGE_CATEGORY.SERVICE_CHARGE &&
                (c.monthYear === monthYear || canAdjustPreviousDue) ? (
                  <EditChargeForm
                    buildingId={buildingId}
                    monthYear={monthYear}
                    chargeId={String(c._id)}
                    description={c.description}
                    amount={c.amount}
                    isPreviousMonth={c.monthYear !== monthYear}
                    canDelete={
                      c.paidAmount === 0 &&
                      (c.monthYear === monthYear || canAdjustPreviousDue)
                    }
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {r.payments.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-black/5 pt-2 dark:border-white/10">
          {r.payments.map((p) => (
            <li
              key={String(p._id)}
              className="flex items-center justify-between text-xs text-black/60 dark:text-white/60"
            >
              <span>
                <span className="text-black/40 dark:text-white/40">
                  {shortDate(p.receivedAt ?? p.createdAt)}
                </span>{" "}
                received
              </span>
              <span className="flex items-center tabular-nums">
                {money(p.totalAmount)}
                {isOpen ? (
                  <EntryDeleteButton
                    action={reversePayment}
                    buildingId={buildingId}
                    monthYear={monthYear}
                    id={String(p._id)}
                    title="Reverse payment"
                    message={`Reverse this payment of ${money(
                      p.totalAmount,
                    )}? The tenant's charges will be restored.`}
                  />
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  const totalReceipts = period.openingBalance + totals.payments + totals.income;
  const cashInHand = totalReceipts - totals.expensesPaid;
  const closing = cashInHand - totals.withdrawals + totals.withdrawalsReturned;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          {buildingName} · {monthLabel(monthYear)}
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
          <div className="flex items-center gap-2">
            <PrintButton fileName={cashbookFileName(buildingName, monthYear)} />
            {canManageMonths ? (
              <form action={closeMonth} className="no-print">
                <input type="hidden" name="buildingId" value={buildingId} />
                <input type="hidden" name="monthYear" value={monthYear} />
                <ConfirmSubmit
                  message={`Close ${monthLabel(monthYear)}? Closing cash in hand will be ${money(
                    closing,
                  )} and carried to the next month. You can reopen it later if you need to make corrections.`}
                  className="inline-flex h-9 items-center justify-center rounded-md border border-black/15 px-4 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
                >
                  Close month
                </ConfirmSubmit>
              </form>
            ) : null}
            <DeleteMonthButton buildingId={buildingId} monthYear={monthYear} />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <PrintButton fileName={cashbookFileName(buildingName, monthYear)} />
            {canManageMonths && canReopen ? (
              <form action={reopenMonth} className="no-print">
                <input type="hidden" name="buildingId" value={buildingId} />
                <input type="hidden" name="monthYear" value={monthYear} />
                <ConfirmSubmit
                  message={`Reopen ${monthLabel(monthYear)} for corrections? It becomes the only editable month, and closing it again will recalculate every later month.`}
                  className="inline-flex h-9 items-center justify-center rounded-md border border-black/15 px-4 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
                >
                  Reopen month
                </ConfirmSubmit>
              </form>
            ) : null}
            <DeleteMonthButton buildingId={buildingId} monthYear={monthYear} />
          </div>
        )}
      </div>

      {/* Summary */}
      <div className="print-avoid-break mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total receipts" value={totalReceipts} />
        <Stat label="Expenses (paid)" value={totals.expensesPaid} />
        <Stat label="Cash in hand" value={cashInHand} />
        <Stat
          label={
            period.status === PERIOD_STATUS.CLOSED
              ? "Closing balance"
              : "Projected closing"
          }
          value={
            period.closingBalance != null ? period.closingBalance : closing
          }
          emphasize
        />
      </div>

      {isOpen && !hasPreviousPeriod ? (
        <OpeningBalanceForm
          buildingId={buildingId}
          monthYear={monthYear}
          openingBalance={period.openingBalance}
        />
      ) : null}

      {/* Notes: carried-in note from the previous month + this month's editable note. */}
      {prevNote || isOpen ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {prevNote ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                Note from{" "}
                {prevNoteMonth ? monthLabel(prevNoteMonth) : "previous month"}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-black/70 dark:text-white/70">
                {prevNote}
              </p>
            </div>
          ) : null}
          {isOpen ? (
            <div className="rounded-lg border border-black/10 p-4 dark:border-white/15">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
                Note for {monthLabel(monthYear)}
              </p>
              <MonthNoteForm
                buildingId={buildingId}
                monthYear={monthYear}
                note={period.note ?? ""}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Receipts */}
        <section className="rounded-lg border border-black/10 dark:border-white/15">
          <header className="border-b border-black/10 px-4 py-3 text-sm font-semibold dark:border-white/15">
            Dr. — Receipts
          </header>
          <div className="divide-y divide-black/5 dark:divide-white/10">
            <Line
              label="Opening — cash in hand"
              amount={period.openingBalance}
              strong
            />

            {activeRows.map(renderReceiptRow)}

            {pastDueRows.length > 0 ? (
              <div className="print-avoid-break px-4 py-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">
                  Past tenants — dues pending
                </p>
                <div className="divide-y divide-black/5 dark:divide-white/10">
                  {pastDueRows.map(renderReceiptRow)}
                </div>
              </div>
            ) : null}

            {/* Add a tenant bill or previous due mid-month */}
            {isOpen ? (
              <div className="px-4 py-3">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">
                  Add tenant bill / previous due
                </p>
                <AddChargeForm
                  buildingId={buildingId}
                  monthYear={monthYear}
                  tenants={tenantOptions}
                />
              </div>
            ) : null}

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
                        <span className="text-black/40 dark:text-white/40">
                          {shortDate(i.receivedAt ?? i.createdAt)}
                        </span>{" "}
                        {i.description}{" "}
                        <span className="text-black/40 dark:text-white/40">
                          ({i.source})
                        </span>
                      </span>
                      <span className="flex items-center tabular-nums">
                        {money(i.amount)}
                        {isOpen ? (
                          <EntryDeleteButton
                            action={deleteIncome}
                            buildingId={buildingId}
                            monthYear={monthYear}
                            id={String(i._id)}
                            title="Delete income"
                            message={`Delete income "${i.description}" (${money(
                              i.amount,
                            )})?`}
                          />
                        ) : null}
                      </span>
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

            {totals.withdrawalsReturned > 0 ? (
              <Line
                label="Withdrawals returned"
                amount={totals.withdrawalsReturned}
              />
            ) : null}
            <Line
              label="Total receipts (incl. opening)"
              amount={totalReceipts}
              strong
            />
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
                  {expenses.map((e) => {
                    const carried = e.monthYear !== monthYear;
                    const paid = e.paidAmount ?? 0;
                    const outstanding = e.amount - paid;
                    const payments = e.payments ?? [];
                    const lastPayment = payments[payments.length - 1];
                    // Undo peels the last payment made this month; delete removes
                    // the whole row but only when it holds no other month's log.
                    const canUndoPayment =
                      isOpen && lastPayment?.monthYear === monthYear;
                    const canDelete =
                      isOpen &&
                      !carried &&
                      payments.every((p) => p.monthYear === monthYear);
                    return (
                      <li key={String(e._id)} className="text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-black/70 dark:text-white/70">
                            <span className="text-black/40 dark:text-white/40">
                              {e.paidAt
                                ? shortDate(e.paidAt)
                                : shortDate(e.createdAt)}
                            </span>{" "}
                            <span className="text-black/40 dark:text-white/40">
                              V#{e.voucherNo}
                            </span>{" "}
                            {e.description}
                            {carried ? (
                              <span className="ml-1 text-black/40 dark:text-white/40">
                                (due from {monthLabel(e.monthYear)})
                              </span>
                            ) : null}
                            {outstanding > 0 ? (
                              <span className="ml-1 text-red-600 dark:text-red-400">
                                {paid > 0 ? "PARTIAL" : "DUE"}
                              </span>
                            ) : null}
                          </span>
                          <span className="flex items-center gap-2 tabular-nums">
                            {money(e.amount)}
                            {canUndoPayment ? (
                              <EntryUndoButton
                                action={reverseExpensePayment}
                                buildingId={buildingId}
                                monthYear={monthYear}
                                id={String(e._id)}
                                title="Undo last payment"
                                message={`Undo the last payment of ${money(
                                  lastPayment.amount,
                                )} on V#${e.voucherNo} "${e.description}"?`}
                              />
                            ) : null}
                            {canDelete ? (
                              <EntryDeleteButton
                                action={deleteExpense}
                                buildingId={buildingId}
                                monthYear={monthYear}
                                id={String(e._id)}
                                title="Delete expense"
                                message={`Delete expense V#${e.voucherNo} "${e.description}" (${money(
                                  e.amount,
                                )})?${paid > 0 ? " Its recorded payment(s) will be removed too." : ""}`}
                              />
                            ) : null}
                          </span>
                        </div>
                        {outstanding > 0 ? (
                          <p className="mt-0.5 text-[11px] text-black/45 dark:text-white/45">
                            {paid > 0 ? `Paid ${money(paid)} · ` : ""}
                            Outstanding {money(outstanding)}
                          </p>
                        ) : null}
                        {isOpen && outstanding > 0 ? (
                          <ExpensePayForm
                            buildingId={buildingId}
                            monthYear={monthYear}
                            expenseId={String(e._id)}
                            outstanding={outstanding}
                          />
                        ) : null}
                      </li>
                    );
                  })}
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
                <ul className="mt-2 space-y-2">
                  {withdrawals.map((w) => {
                    const carried = w.monthYear !== monthYear;
                    const returned = w.returnedAmount ?? 0;
                    const outstanding = w.amount - returned;
                    const returns = w.returns ?? [];
                    const lastReturn = returns[returns.length - 1];
                    // Undo peels the last return made this month; delete removes
                    // the whole row but only when it holds no other month's log.
                    const canUndoReturn =
                      isOpen && lastReturn?.monthYear === monthYear;
                    const canDelete =
                      isOpen &&
                      !carried &&
                      returns.every((r) => r.monthYear === monthYear);
                    return (
                      <li key={String(w._id)} className="text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-black/70 dark:text-white/70">
                            <span className="text-black/40 dark:text-white/40">
                              {shortDate(w.takenAt ?? w.createdAt)}
                            </span>{" "}
                            {w.takenBy}
                            {w.note ? (
                              <span className="text-black/40 dark:text-white/40">
                                {" "}
                                · {w.note}
                              </span>
                            ) : null}
                            {carried ? (
                              <span className="ml-1 text-black/40 dark:text-white/40">
                                (advance from {monthLabel(w.monthYear)})
                              </span>
                            ) : null}
                          </span>
                          <span className="flex items-center gap-2 tabular-nums">
                            {money(w.amount)}
                            {canUndoReturn ? (
                              <EntryUndoButton
                                action={reverseWithdrawalReturn}
                                buildingId={buildingId}
                                monthYear={monthYear}
                                id={String(w._id)}
                                title="Undo last return"
                                message={`Undo the last return of ${money(
                                  lastReturn.amount,
                                )} by ${w.takenBy}?`}
                              />
                            ) : null}
                            {canDelete ? (
                              <EntryDeleteButton
                                action={deleteWithdrawal}
                                buildingId={buildingId}
                                monthYear={monthYear}
                                id={String(w._id)}
                                title="Delete withdrawal"
                                message={`Delete withdrawal by ${w.takenBy} (${money(
                                  w.amount,
                                )})?${returned > 0 ? " Its recorded return(s) will be removed too." : ""}`}
                              />
                            ) : null}
                          </span>
                        </div>
                        {outstanding > 0 ? (
                          <p className="mt-0.5 text-[11px] text-black/45 dark:text-white/45">
                            {returned > 0
                              ? `Returned ${money(returned)} · `
                              : ""}
                            Outstanding {money(outstanding)}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-[11px] text-green-600 dark:text-green-400">
                            Fully returned
                          </p>
                        )}
                        {isOpen && outstanding > 0 ? (
                          <WithdrawalReturnForm
                            buildingId={buildingId}
                            monthYear={monthYear}
                            withdrawalId={String(w._id)}
                            outstanding={outstanding}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {isOpen ? (
                <div className="mt-3">
                  <WithdrawalForm
                    buildingId={buildingId}
                    monthYear={monthYear}
                  />
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

function Stat({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: number;
  emphasize?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        emphasize
          ? "border-foreground/30 bg-black/2 dark:bg-white/5"
          : "border-black/10 dark:border-white/15"
      }`}
    >
      <p className="text-xs text-black/50 dark:text-white/50">{label}</p>
      <p
        className={`mt-1 tabular-nums ${
          emphasize ? "text-lg font-semibold" : "text-base font-medium"
        }`}
      >
        {money(value)}
      </p>
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

function DeleteMonthButton({
  buildingId,
  monthYear,
}: {
  buildingId: string;
  monthYear: string;
}) {
  return (
    <form action={deleteMonth} className="no-print">
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="monthYear" value={monthYear} />
      <ConfirmSubmit
        message={`Delete ${monthLabel(
          monthYear,
        )} entirely? This permanently removes all its payments, income, expenses, withdrawals and charges, and recalculates every later month. This cannot be undone.`}
        className="inline-flex h-9 items-center justify-center rounded-md border border-red-500/40 px-4 text-sm font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
      >
        Delete month
      </ConfirmSubmit>
    </form>
  );
}

/** Printable paper cash book (hidden on screen, shown only when printing). */
async function PrintCashBook({
  buildingId,
  buildingName,
  buildingAddress,
  period,
}: {
  buildingId: string;
  buildingName: string;
  buildingAddress: string | null;
  period: {
    monthYear: string;
    openingBalance: number;
    status: string;
    closingBalance?: number | null;
    note?: string | null;
    roster?: {
      tenancyId: unknown;
      userId: unknown;
      unitId: unknown;
      unitLabel?: string | null;
      tenantName?: string | null;
    }[];
  };
}) {
  const monthYear = period.monthYear;

  // A month's tenants come from its immutable open-time snapshot (or a date
  // reconstruction for older months); later assignments never appear here.
  const [
    roster,
    incomes,
    rawExpenses,
    rawWithdrawals,
    payments,
    totals,
    prevPeriod,
  ] = await Promise.all([
    // On an open month, include past tenants who still owe so their dues
    // print in the dedicated past-tenants section.
    resolveMonthRoster(buildingId, monthYear, period.roster, {
      includeOutstanding: period.status === PERIOD_STATUS.OPEN,
    }),
    Income.find({ buildingId, monthYear }).sort({ receivedAt: 1 }).lean(),
    Expense.find(expenseMonthQuery(buildingId, monthYear))
      .sort({ monthYear: 1, voucherNo: 1 })
      .lean(),
    Withdrawal.find(withdrawalMonthQuery(buildingId, monthYear))
      .sort({ monthYear: 1, takenAt: 1 })
      .lean(),
    Payment.find({ buildingId, monthYear }).lean(),
    getPeriodTotals(buildingId, monthYear),
    MonthlyPeriod.findOne({ buildingId, monthYear: { $lt: monthYear } })
      .sort({ monthYear: -1 })
      .select("monthYear note")
      .lean(),
  ]);

  // Settle each expense only with payments up to this month so a payable paid
  // later still prints as owed here and legacy paid rows read as settled.
  const expenses = rawExpenses.map((e) => {
    const paid = expensePaidAsOf(e, monthYear);
    return {
      ...e,
      paidAmount: paid,
      status:
        e.amount - paid <= 0
          ? EXPENSE_STATUS.PAID
          : paid > 0
            ? EXPENSE_STATUS.PARTIAL
            : EXPENSE_STATUS.DUE,
    };
  });

  // Advances shown with what was returned as of this month.
  const withdrawals = rawWithdrawals.map((w) => ({
    ...w,
    returnedAmount: withdrawalReturnedAsOf(w, monthYear),
  }));

  const tenancyIds = roster.map((r) => r.tenancyId);
  // Settle each charge only with payments up to this month, then keep the ones
  // still owed then — so a due cleared in a later month still prints here.
  const paidAsOf = await paidByChargeAsOf(buildingId, monthYear);
  const dueCharges = (
    await Charge.find({
      tenancyId: { $in: tenancyIds },
      monthYear: { $lte: monthYear },
    })
      .sort({ monthYear: 1 })
      .lean()
  )
    .map((c) => {
      const state = chargeStateAsOf(c.amount, paidAsOf.get(String(c._id)) ?? 0);
      return { ...c, paidAmount: state.paidAmount, status: state.status };
    })
    .filter((c) => c.status !== CHARGE_STATUS.PAID);

  const prevNote = prevPeriod?.note?.trim() ? prevPeriod.note.trim() : null;
  const prevNoteMonth = prevPeriod?.monthYear ?? null;
  const currentNote = period.note?.trim() ? period.note.trim() : null;

  const paidByTenancy = new Map<string, number>();
  for (const p of payments) {
    const k = String(p.tenancyId);
    paidByTenancy.set(k, (paidByTenancy.get(k) ?? 0) + p.totalAmount);
  }
  const duesByTenancy = new Map<string, typeof dueCharges>();
  for (const c of dueCharges) {
    const k = String(c.tenancyId);
    const list = duesByTenancy.get(k) ?? [];
    list.push(c);
    duesByTenancy.set(k, list);
  }

  const rows = roster
    .map((r) => {
      const dues = duesByTenancy.get(r.tenancyId) ?? [];
      return {
        unit: r.unitLabel,
        name: r.tenantName,
        isPastTenant: r.isPastForMonth,
        paid: paidByTenancy.get(r.tenancyId) ?? 0,
        dueTotal: dues.reduce((s, c) => s + (c.amount - c.paidAmount), 0),
        dues: dues.map((c) => ({
          id: String(c._id),
          description: c.description,
          monthYear: c.monthYear,
          amount: c.amount,
          paidAmount: c.paidAmount,
          remaining: c.amount - c.paidAmount,
        })),
      };
    })
    .sort((a, b) => compareUnitLabels(a.unit, b.unit));

  const tenantPaidTotal = rows.reduce((s, r) => s + r.paid, 0);
  const incomeTotal = incomes.reduce((s, i) => s + i.amount, 0);
  const totalReceipts =
    period.openingBalance +
    totals.payments +
    totals.income +
    totals.withdrawalsReturned;
  const cashInHand = totalReceipts - totals.expensesPaid - totals.withdrawals;
  const closing =
    period.status === PERIOD_STATUS.CLOSED && period.closingBalance != null
      ? period.closingBalance
      : cashInHand;
  const isCurrent = monthYear === currentMonthYear();
  const withdrawalRows = withdrawals.map((w) => {
    const returned = w.returnedAmount ?? 0;
    return {
      id: String(w._id),
      takenBy: w.takenBy,
      note: w.note ?? null,
      fromMonth: w.monthYear !== monthYear ? w.monthYear : null,
      amount: w.amount,
      returned,
      outstanding: w.amount - returned,
    };
  });

  const cell = "border-b border-black/25 py-[1.5px] align-top";

  const activePrintRows = rows.filter((r) => !r.isPastTenant);
  const pastDuePrintRows = rows.filter((r) => r.isPastTenant && r.dueTotal > 0);

  const renderPrintRow = (r: (typeof rows)[number]) => (
    <Fragment key={`${r.unit}-${r.name}`}>
      <tr>
        <td className={cell}>
          {r.unit} · {r.name}
        </td>
        <td className={`${cell} text-right tabular-nums`}>{money(r.paid)}</td>
        <td
          className={`${cell} text-right tabular-nums ${
            r.dueTotal > 0 ? "font-medium text-red-600" : ""
          }`}
        >
          {r.dueTotal > 0 ? money(r.dueTotal) : "—"}
        </td>
      </tr>
      {r.dues.map((d) => (
        <tr key={d.id}>
          <td className="py-0 pl-3 text-[9px] text-black/70">
            ↳ {d.description} · {monthLabel(d.monthYear)}
            <span className="text-black/50">
              {" "}
              (total {money(d.amount)}
              {d.paidAmount > 0 ? `, paid ${money(d.paidAmount)}` : ""})
            </span>
          </td>
          <td />
          <td className="py-0 text-right text-[9px] tabular-nums text-red-600">
            {money(d.remaining)}
          </td>
        </tr>
      ))}
    </Fragment>
  );

  return (
    <div className="print-only text-[10px] leading-tight text-black">
      <header className="text-center">
        <h1 className="text-sm font-bold">{buildingName}</h1>
        {buildingAddress ? (
          <p className="text-[9px]">{buildingAddress}</p>
        ) : null}
        <p className="text-[10px] font-medium">
          Cash Book — {monthLabel(monthYear)}{" "}
          <span className="font-normal">
            ({period.status === PERIOD_STATUS.CLOSED ? "Closed" : "Open"})
          </span>
        </p>
        <p className="text-[10px]">
          Opening (cash in hand):{" "}
          <span className="font-semibold">{money(period.openingBalance)}</span>
        </p>
      </header>

      <div className="mt-2 grid grid-cols-2 gap-4">
        {/* Left — receipts */}
        <div className="print-avoid-break">
          <h2 className="border-b border-black pb-0.5 text-[11px] font-bold">
            Dr. — Receipts
          </h2>
          <table className="w-full">
            <thead>
              <tr className="text-left text-[9px]">
                <th className="py-0.5">Particulars</th>
                <th className="py-0.5 text-right">Paid</th>
                <th className="py-0.5 text-right">Due</th>
              </tr>
            </thead>
            <tbody>
              {activePrintRows.map(renderPrintRow)}
              {pastDuePrintRows.length > 0 ? (
                <>
                  <tr>
                    <td
                      className="pt-1 pb-0.5 text-[9px] font-semibold uppercase"
                      colSpan={3}
                    >
                      Past tenants — dues pending
                    </td>
                  </tr>
                  {pastDuePrintRows.map(renderPrintRow)}
                </>
              ) : null}
              {incomes.map((i) => (
                <tr key={String(i._id)}>
                  <td className={cell}>
                    {i.description}{" "}
                    <span className="text-black/60">({i.source})</span>
                  </td>
                  <td className={`${cell} text-right tabular-nums`}>
                    {money(i.amount)}
                  </td>
                  <td className={cell} />
                </tr>
              ))}
              {totals.withdrawalsReturned > 0 ? (
                <tr>
                  <td className={cell}>Withdrawals returned</td>
                  <td className={`${cell} text-right tabular-nums`}>
                    {money(totals.withdrawalsReturned)}
                  </td>
                  <td className={cell} />
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="py-0.5">Total receipts</td>
                <td className="py-0.5 text-right tabular-nums">
                  {money(
                    tenantPaidTotal + incomeTotal + totals.withdrawalsReturned,
                  )}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Right — expenses */}
        <div className="print-avoid-break">
          <h2 className="border-b border-black pb-0.5 text-[11px] font-bold">
            Cr. — Payments / Expenses
          </h2>
          <table className="w-full">
            <thead>
              <tr className="text-left text-[9px]">
                <th className="py-0.5">Particulars</th>
                <th className="py-0.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {expenses.length === 0 ? (
                <tr>
                  <td className={cell} colSpan={2}>
                    No expenses.
                  </td>
                </tr>
              ) : (
                expenses.map((e) => (
                  <tr key={String(e._id)}>
                    <td className={cell}>
                      <span className="text-black/60">V#{e.voucherNo}</span>{" "}
                      {e.description}
                      {e.monthYear !== monthYear ? (
                        <span className="text-black/50">
                          {" "}
                          (due from {monthLabel(e.monthYear)})
                        </span>
                      ) : null}
                      {e.status === EXPENSE_STATUS.DUE ? (
                        <span className="text-red-600"> (DUE)</span>
                      ) : e.status === EXPENSE_STATUS.PARTIAL ? (
                        <span className="text-red-600"> (PARTIAL)</span>
                      ) : null}
                    </td>
                    <td className={`${cell} text-right tabular-nums`}>
                      {money(e.amount)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="py-0.5">Total expenses (paid)</td>
                <td className="py-0.5 text-right tabular-nums">
                  {money(totals.expensesPaid)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Withdrawals — taken, returned, pending */}
      {withdrawalRows.length > 0 ? (
        <div className="mt-2 print-avoid-break">
          <h2 className="border-b border-black pb-0.5 text-[11px] font-bold">
            Withdrawals (advances)
          </h2>
          <table className="w-full">
            <thead>
              <tr className="text-left text-[9px]">
                <th className="py-0.5">Taken by</th>
                <th className="py-0.5 text-right">Taken</th>
                <th className="py-0.5 text-right">Returned</th>
                <th className="py-0.5 text-right">Pending</th>
                <th className="py-0.5 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {withdrawalRows.map((w) => (
                <tr key={w.id}>
                  <td className={cell}>
                    {w.takenBy}
                    {w.note ? (
                      <span className="text-black/50"> · {w.note}</span>
                    ) : null}
                    {w.fromMonth ? (
                      <span className="text-black/50">
                        {" "}
                        (from {monthLabel(w.fromMonth)})
                      </span>
                    ) : null}
                  </td>
                  <td className={`${cell} text-right tabular-nums`}>
                    {money(w.amount)}
                  </td>
                  <td className={`${cell} text-right tabular-nums`}>
                    {w.returned > 0 ? money(w.returned) : "—"}
                  </td>
                  <td
                    className={`${cell} text-right tabular-nums ${
                      w.outstanding > 0 ? "font-medium text-red-600" : ""
                    }`}
                  >
                    {w.outstanding > 0 ? money(w.outstanding) : "—"}
                  </td>
                  <td className={`${cell} text-right`}>
                    {w.outstanding <= 0
                      ? "Repaid"
                      : w.returned > 0
                        ? "Partial"
                        : "Pending"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Notes */}
      {currentNote || prevNote ? (
        <div className="mt-2 print-avoid-break">
          <h2 className="border-b border-black pb-0.5 text-[11px] font-bold">
            Notes
          </h2>
          {currentNote ? (
            <p className="mt-0.5 whitespace-pre-wrap">
              <span className="font-semibold">
                Note for {monthLabel(monthYear)}:
              </span>{" "}
              {currentNote}
            </p>
          ) : null}
          {prevNote ? (
            <p className="mt-0.5 whitespace-pre-wrap">
              <span className="font-semibold">
                Note from{" "}
                {prevNoteMonth ? monthLabel(prevNoteMonth) : "previous month"}:
              </span>{" "}
              {prevNote}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Footer — cash in hand */}
      <div className="mt-2 border-t border-black pt-1 print-avoid-break">
        <div className="flex justify-between">
          <span>Total receipts (incl. opening)</span>
          <span className="tabular-nums">{money(totalReceipts)}</span>
        </div>
        <div className="flex justify-between">
          <span>Less total expenses (paid)</span>
          <span className="tabular-nums">{money(totals.expensesPaid)}</span>
        </div>
        {totals.withdrawals > 0 ? (
          <div className="flex justify-between">
            <span>Less withdrawals</span>
            <span className="tabular-nums">{money(totals.withdrawals)}</span>
          </div>
        ) : null}
        <div className="mt-0.5 flex justify-between border-t border-black pt-0.5 text-[12px] font-bold">
          <span>
            {isCurrent
              ? "Current cash in hand"
              : `Cash in hand at end of ${monthLabel(monthYear)}`}
          </span>
          <span className="tabular-nums">{money(closing)}</span>
        </div>
      </div>
    </div>
  );
}
