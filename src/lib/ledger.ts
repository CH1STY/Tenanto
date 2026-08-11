import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Payment } from "@/models/Payment";
import { Income } from "@/models/Income";
import { Expense } from "@/models/Expense";
import { Withdrawal } from "@/models/Withdrawal";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { Tenancy } from "@/models/Tenancy";
import { Unit } from "@/models/Unit";
import { User } from "@/models/User";
import { Charge } from "@/models/Charge";
import { monthRange } from "@/lib/dates";
import { CHARGE_STATUS, EXPENSE_STATUS, PERIOD_STATUS } from "@/lib/constants";

export type PeriodTotals = {
  payments: number;
  income: number;
  expensesPaid: number;
  withdrawals: number;
  withdrawalsReturned: number;
};

export type MonthRosterEntry = {
  tenancyId: string;
  unitId: string;
  userId: string;
  unitLabel: string;
  tenantName: string;
  isActive: boolean;
  // True only when the tenant is not part of this month's roster and was
  // pulled in solely because they still owe (a past tenant for this month).
  isPastForMonth: boolean;
};

type StoredRosterEntry = {
  tenancyId: unknown;
  userId: unknown;
  unitId: unknown;
  unitLabel?: string | null;
  tenantName?: string | null;
};

/**
 * The tenants that belong to a building's month. Prefers the immutable roster
 * captured when the month was opened; for months opened before snapshots
 * existed it reconstructs the roster from tenancy date ranges. Either way it
 * also includes anyone who transacted this month (e.g. a mid-month assignment).
 */
export async function resolveMonthRoster(
  buildingId: string,
  monthYear: string,
  storedRoster?: StoredRosterEntry[] | null,
  options?: { includeOutstanding?: boolean },
): Promise<MonthRosterEntry[]> {
  await connectDB();

  const stored = storedRoster ?? [];
  const tenancyIds = new Set<string>();

  if (stored.length > 0) {
    for (const r of stored) tenancyIds.add(String(r.tenancyId));
  } else {
    const { start, end } = monthRange(monthYear);
    const overlapping = await Tenancy.find({
      buildingId,
      startDate: { $lte: end },
      $or: [{ endDate: null }, { endDate: { $gte: start } }],
    })
      .select("_id")
      .lean();
    for (const t of overlapping) tenancyIds.add(String(t._id));
  }

  const [monthCharges, monthPayments] = await Promise.all([
    Charge.find({ buildingId, monthYear }).select("tenancyId").lean(),
    Payment.find({ buildingId, monthYear }).select("tenancyId").lean(),
  ]);
  for (const c of monthCharges) tenancyIds.add(String(c.tenancyId));
  for (const p of monthPayments) tenancyIds.add(String(p.tenancyId));

  // Tenants that genuinely belong to this month: the open-time roster snapshot
  // (or date-overlap) plus anyone who transacted this month. Whoever is added
  // afterwards only because they still owe is a past tenant for this month.
  const monthTenancyIds = new Set(tenancyIds);

  if (options?.includeOutstanding) {
    // Surface anyone who still owed **as of this month** — including tenants
    // who have since detached, paid off later, or had the due adjusted in a
    // later month — so every month faithfully keeps its outstanding tenants
    // regardless of what happened afterwards. Also surface anyone whose due
    // was adjusted *in* this month, so that edit stays visible on the month it
    // was made even when it cleared the charge to zero.
    const asOfCharges = await Charge.find({
      buildingId,
      monthYear: { $lte: monthYear },
    })
      .select("tenancyId amount description adjustments")
      .lean();
    const paidAsOf = await paidByChargeAsOf(buildingId, monthYear);
    for (const c of asOfCharges) {
      const adjustedThisMonth = (c.adjustments ?? []).some(
        (a) => a.monthYear === monthYear,
      );
      const { amount } = chargeAmountAsOf(c, monthYear);
      const paid = Math.min(
        amount,
        Math.max(0, paidAsOf.get(String(c._id)) ?? 0),
      );
      if (amount - paid > 0 || adjustedThisMonth) {
        tenancyIds.add(String(c.tenancyId));
      }
    }
  }

  const ids = [...tenancyIds];
  if (ids.length === 0) return [];

  const tenancies = await Tenancy.find({ _id: { $in: ids } }).lean();
  const storedByTenancy = new Map(stored.map((r) => [String(r.tenancyId), r]));

  // Resolve current labels only where a stored snapshot label is missing.
  const unitLookup: string[] = [];
  const userLookup: string[] = [];
  for (const t of tenancies) {
    const snap = storedByTenancy.get(String(t._id));
    if (!snap?.unitLabel) unitLookup.push(String(t.unitId));
    if (!snap?.tenantName) userLookup.push(String(t.userId));
  }
  const [units, users] = await Promise.all([
    unitLookup.length
      ? Unit.find({ _id: { $in: unitLookup } })
          .select("label")
          .lean()
      : [],
    userLookup.length
      ? User.find({ _id: { $in: userLookup } })
          .select("name")
          .lean()
      : [],
  ]);
  const unitLabel = new Map(units.map((u) => [String(u._id), u.label]));
  const userName = new Map(users.map((u) => [String(u._id), u.name]));

  return tenancies.map((t) => {
    const snap = storedByTenancy.get(String(t._id));
    return {
      tenancyId: String(t._id),
      unitId: String(t.unitId),
      userId: String(t.userId),
      unitLabel: snap?.unitLabel || unitLabel.get(String(t.unitId)) || "?",
      tenantName:
        snap?.tenantName || userName.get(String(t.userId)) || "Tenant",
      isActive: Boolean(t.isActive),
      isPastForMonth: !monthTenancyIds.has(String(t._id)),
    };
  });
}

const first = (rows: { s: number }[]) => rows[0]?.s ?? 0;

/**
 * Sum of payment allocations applied to each charge **as of** a month — only
 * counting payments received in `monthYear` or earlier. A charge's live
 * `paidAmount` is a single running total, so a due paid in a later month would
 * otherwise make a past month's cash book show it as settled. Rendering each
 * month from this ledger keeps every month's dues true to when cash arrived.
 */
export async function paidByChargeAsOf(
  buildingId: string,
  monthYear: string,
): Promise<Map<string, number>> {
  await connectDB();
  const rows = await Payment.aggregate<{ _id: Types.ObjectId; s: number }>([
    {
      $match: {
        buildingId: new Types.ObjectId(buildingId),
        monthYear: { $lte: monthYear },
      },
    },
    { $unwind: "$allocations" },
    {
      $group: {
        _id: "$allocations.chargeId",
        s: { $sum: "$allocations.amount" },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.s]));
}

/** Derive a charge's settled amount, remaining, and status from an as-of paid total. */
export function chargeStateAsOf(
  amount: number,
  paidAsOf: number,
): { paidAmount: number; remaining: number; status: string } {
  const paidAmount = Math.min(amount, Math.max(0, paidAsOf));
  return {
    paidAmount,
    remaining: amount - paidAmount,
    status:
      paidAmount <= 0
        ? CHARGE_STATUS.DUE
        : paidAmount >= amount
          ? CHARGE_STATUS.PAID
          : CHARGE_STATUS.PARTIAL,
  };
}

type ChargeAdjustment = {
  monthYear: string;
  amount: number;
  description: string;
  prevAmount: number;
  prevDescription: string;
  at?: Date | string | null;
};

/**
 * A charge's amount and description **as of** a month. Each adjustment is logged
 * with the month it was made in and takes effect from that month onward, so a
 * later edit never rewrites how a past month reads. Months before the first
 * edit show the original (pre-adjustment) values.
 */
export function chargeAmountAsOf(
  c: {
    amount: number;
    description: string;
    adjustments?: ChargeAdjustment[] | null;
  },
  monthYear: string,
): { amount: number; description: string } {
  const log = c.adjustments ?? [];
  if (log.length === 0) return { amount: c.amount, description: c.description };
  const byTime = (a: ChargeAdjustment, b: ChargeAdjustment) =>
    +new Date(a.at ?? 0) - +new Date(b.at ?? 0);
  const applied = log.filter((a) => a.monthYear <= monthYear).sort(byTime);
  if (applied.length > 0) {
    const last = applied[applied.length - 1];
    return { amount: last.amount, description: last.description };
  }
  const first = [...log].sort(byTime)[0];
  return { amount: first.prevAmount, description: first.prevDescription };
}

type MonthLog = { amount: number; monthYear: string };

/**
 * Amount settled toward an expense **as of** a month. Uses the per-payment log
 * (only entries in `monthYear` or earlier) so a bill paid in a later month
 * still reads as owed in an earlier one. Rows imported/created before the log
 * existed carry no entries: a `PAID` status means fully settled, otherwise the
 * stored running total stands.
 */
export function expensePaidAsOf(
  e: {
    amount: number;
    status?: string | null;
    paidAmount?: number | null;
    payments?: MonthLog[] | null;
  },
  monthYear: string,
): number {
  const log = e.payments ?? [];
  if (log.length > 0) {
    const paid = log
      .filter((p) => p.monthYear <= monthYear)
      .reduce((s, p) => s + p.amount, 0);
    return Math.min(e.amount, paid);
  }
  if (e.status === EXPENSE_STATUS.PAID) return e.amount;
  return Math.min(e.amount, Math.max(0, e.paidAmount ?? 0));
}

/** Amount returned toward a withdrawal **as of** a month (same as-of rules). */
export function withdrawalReturnedAsOf(
  w: {
    amount: number;
    returnedAmount?: number | null;
    returns?: MonthLog[] | null;
  },
  monthYear: string,
): number {
  const log = w.returns ?? [];
  if (log.length > 0) {
    const ret = log
      .filter((r) => r.monthYear <= monthYear)
      .reduce((s, r) => s + r.amount, 0);
    return Math.min(w.amount, ret);
  }
  return Math.min(w.amount, Math.max(0, w.returnedAmount ?? 0));
}

// Mongo $expr: money is still owed on a `logField` entity as of `monthYear`,
// counting only log entries up to that month; legacy rows with no log fall back
// to a paid status (fully settled) or the stored running total.
function owedAsOfExpr(
  monthYear: string,
  logField: string,
  runningField: string,
  paidStatus: string | null,
) {
  const legacyPaid = paidStatus
    ? {
        $cond: [
          { $eq: ["$status", paidStatus] },
          "$amount",
          { $ifNull: [`$${runningField}`, 0] },
        ],
      }
    : { $ifNull: [`$${runningField}`, 0] };
  return {
    $let: {
      vars: { log: { $ifNull: [`$${logField}`, []] } },
      in: {
        $gt: [
          "$amount",
          {
            $cond: [
              { $gt: [{ $size: "$$log" }, 0] },
              {
                $sum: {
                  $map: {
                    input: {
                      $filter: {
                        input: "$$log",
                        as: "e",
                        cond: { $lte: ["$$e.monthYear", monthYear] },
                      },
                    },
                    as: "e",
                    in: "$$e.amount",
                  },
                },
              },
              legacyPaid,
            ],
          },
        ],
      },
    },
  };
}

// Mongo $expr: the entity has at least one `logField` entry recorded **in**
// `monthYear` — i.e. it was paid/returned against this month — so a carried
// payable settled this month stays visible (and undoable) on the month the
// cash actually moved, even once it's fully cleared.
function activityInMonthExpr(monthYear: string, logField: string) {
  return {
    $gt: [
      {
        $size: {
          $filter: {
            input: { $ifNull: [`$${logField}`, []] },
            as: "e",
            cond: { $eq: ["$$e.monthYear", monthYear] },
          },
        },
      },
      0,
    ],
  };
}

/**
 * Query for a building's expenses shown in a month: this month's plus any
 * carried payable still owed **as of** this month, or one that was paid against
 * this month (so a due cleared now stays visible to review or undo). A prior
 * bill settled in another month no longer leaks in, and legacy paid rows with
 * no payment log never carry.
 */
export function expenseMonthQuery(buildingId: string, monthYear: string) {
  return {
    buildingId,
    $or: [
      { monthYear },
      {
        monthYear: { $lt: monthYear },
        $expr: {
          $or: [
            owedAsOfExpr(
              monthYear,
              "payments",
              "paidAmount",
              EXPENSE_STATUS.PAID,
            ),
            activityInMonthExpr(monthYear, "payments"),
          ],
        },
      },
    ],
  };
}

/**
 * Query for a month's withdrawals: this month's plus advances still out as of
 * it, or ones returned against this month (so a repayment made now stays
 * visible to review or undo even once fully returned).
 */
export function withdrawalMonthQuery(buildingId: string, monthYear: string) {
  return {
    buildingId,
    $or: [
      { monthYear },
      {
        monthYear: { $lt: monthYear },
        $expr: {
          $or: [
            owedAsOfExpr(monthYear, "returns", "returnedAmount", null),
            activityInMonthExpr(monthYear, "returns"),
          ],
        },
      },
    ],
  };
}

/** Money totals for a building's month, used for the cash book and closing. */
export async function getPeriodTotals(
  buildingId: string,
  monthYear: string,
): Promise<PeriodTotals> {
  await connectDB();
  const buildingObjectId = new Types.ObjectId(buildingId);
  const match = { buildingId: buildingObjectId, monthYear };

  const [
    payments,
    income,
    expensesPaidFromPayments,
    expensesPaidLegacy,
    withdrawals,
    withdrawalsReturned,
  ] = await Promise.all([
    Payment.aggregate<{ s: number }>([
      { $match: match },
      { $group: { _id: null, s: { $sum: "$totalAmount" } } },
    ]),
    Income.aggregate<{ s: number }>([
      { $match: match },
      { $group: { _id: null, s: { $sum: "$amount" } } },
    ]),
    // Expense payments are attributed to the month cash actually went out.
    Expense.aggregate<{ s: number }>([
      { $match: { buildingId: buildingObjectId } },
      { $unwind: "$payments" },
      { $match: { "payments.monthYear": monthYear } },
      { $group: { _id: null, s: { $sum: "$payments.amount" } } },
    ]),
    // Legacy fully-paid expenses (no per-payment log) count in their own month.
    Expense.aggregate<{ s: number }>([
      {
        $match: {
          ...match,
          status: EXPENSE_STATUS.PAID,
          $or: [{ payments: { $exists: false } }, { payments: { $size: 0 } }],
        },
      },
      { $group: { _id: null, s: { $sum: "$amount" } } },
    ]),
    Withdrawal.aggregate<{ s: number }>([
      { $match: match },
      { $group: { _id: null, s: { $sum: "$amount" } } },
    ]),
    // Returns are attributed to the month the cash came back, wherever the
    // original withdrawal was taken.
    Withdrawal.aggregate<{ s: number }>([
      { $match: { buildingId: buildingObjectId } },
      { $unwind: "$returns" },
      { $match: { "returns.monthYear": monthYear } },
      { $group: { _id: null, s: { $sum: "$returns.amount" } } },
    ]),
  ]);

  return {
    payments: first(payments),
    income: first(income),
    expensesPaid: first(expensesPaidFromPayments) + first(expensesPaidLegacy),
    withdrawals: first(withdrawals),
    withdrawalsReturned: first(withdrawalsReturned),
  };
}

/** Cash in hand at month end = opening + receipts − paid expenses − withdrawals + returns. */
export function computeClosing(opening: number, t: PeriodTotals): number {
  return (
    opening +
    t.payments +
    t.income -
    t.expensesPaid -
    t.withdrawals +
    t.withdrawalsReturned
  );
}

/**
 * Cascade the cash-in-hand chain to every month after `fromMonthYear`, so
 * reopening/closing a previous month keeps later openings and closings correct.
 */
export async function recalcForwardChain(
  buildingId: string,
  fromMonthYear: string,
  fromClosingBalance: number,
): Promise<void> {
  await connectDB();
  const later = await MonthlyPeriod.find({
    buildingId,
    monthYear: { $gt: fromMonthYear },
  }).sort({ monthYear: 1 });

  let prevClosing = fromClosingBalance;
  for (const p of later) {
    const totals = await getPeriodTotals(buildingId, p.monthYear);
    p.openingBalance = prevClosing;
    const projected = computeClosing(prevClosing, totals);
    if (p.status === PERIOD_STATUS.CLOSED) p.closingBalance = projected;
    prevClosing = projected;
    await p.save();
  }
}
