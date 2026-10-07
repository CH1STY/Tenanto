"use server";

import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Charge } from "@/models/Charge";
import { Income } from "@/models/Income";
import { Expense } from "@/models/Expense";
import { Withdrawal } from "@/models/Withdrawal";
import { Payment } from "@/models/Payment";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { MonthMedia } from "@/models/MonthMedia";
import {
  getPeriodTotals,
  resolveMonthRoster,
  paidByChargeAsOf,
  chargeStateAsOf,
  chargeAmountAsOf,
  expenseMonthQuery,
  withdrawalMonthQuery,
  expensePaidAsOf,
  expensePaidInMonth,
  withdrawalReturnedAsOf,
} from "@/lib/ledger";
import { shortDate } from "@/lib/dates";
import { compareUnitLabels } from "@/lib/units";
import {
  CHARGE_CATEGORY,
  CHARGE_STATUS,
  EXPENSE_STATUS,
} from "@/lib/constants";
import { objectIdSchema } from "@/lib/validators/building";
import type { CashBookData } from "./cashbook";

/** Read-only, fully serializable cash book for one building month (public view). */
export async function loadCashBook(
  buildingId: string,
  monthYear: string,
): Promise<CashBookData | null> {
  if (!objectIdSchema.safeParse(buildingId).success) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthYear)) return null;

  await connectDB();

  const period = await MonthlyPeriod.findOne({ buildingId, monthYear }).lean();
  if (!period) return null;

  // The month's tenant roster: its immutable open-time snapshot when present,
  // plus anyone who still owed as of this month (even if they've since detached
  // or paid off later) and anyone whose due was adjusted this month, so each
  // month keeps its outstanding tenants and edits visible on the month they
  // happened — open or closed.
  const roster = await resolveMonthRoster(
    buildingId,
    monthYear,
    period.roster,
    {
      includeOutstanding: true,
    },
  );
  const tenancyIds = roster.map((r) => r.tenancyId);

  const [
    building,
    rawCharges,
    incomes,
    expenses,
    withdrawals,
    payments,
    totals,
    prevPeriod,
    paidAsOf,
    mediaDocs,
  ] = await Promise.all([
    Building.findById(buildingId).select("name address").lean(),
    // Cap charges to this month or earlier so a later month's dues never leak in.
    Charge.find({
      tenancyId: { $in: tenancyIds },
      monthYear: { $lte: monthYear },
    })
      .sort({ monthYear: 1 })
      .lean(),
    Income.find({ buildingId, monthYear }).sort({ receivedAt: 1 }).lean(),
    // Carried-forward payables still owed as of this month show until settled.
    Expense.find(expenseMonthQuery(buildingId, monthYear))
      .sort({ monthYear: 1, voucherNo: 1 })
      .lean(),
    // Advances still out as of this month forward until fully returned.
    Withdrawal.find(withdrawalMonthQuery(buildingId, monthYear))
      .sort({ monthYear: 1, takenAt: 1 })
      .lean(),
    Payment.find({ buildingId, monthYear }).lean(),
    getPeriodTotals(buildingId, monthYear),
    MonthlyPeriod.findOne({ buildingId, monthYear: { $lt: monthYear } })
      .sort({ monthYear: -1 })
      .select("monthYear note")
      .lean(),
    paidByChargeAsOf(buildingId, monthYear),
    MonthMedia.find({ buildingId, monthYear })
      .select("-data")
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  // Settle each charge only with payments received up to this month, and read
  // its amount/description as of this month, so a later edit or a due paid in a
  // later month never rewrites this month's snapshot.
  const charges = rawCharges.map((c) => {
    const asOf = chargeAmountAsOf(c, monthYear);
    const state = chargeStateAsOf(
      asOf.amount,
      paidAsOf.get(String(c._id)) ?? 0,
    );
    return {
      ...c,
      amount: asOf.amount,
      description: asOf.description,
      paidAmount: state.paidAmount,
      status: state.status,
    };
  });

  const prevNote = prevPeriod?.note?.trim() ? prevPeriod.note.trim() : null;
  const prevNoteMonth = prevPeriod?.monthYear ?? null;

  const paidByTenancy = new Map<string, number>();
  for (const p of payments) {
    const k = String(p.tenancyId);
    paidByTenancy.set(k, (paidByTenancy.get(k) ?? 0) + p.totalAmount);
  }
  const dueByTenancy = new Map<string, number>();
  for (const c of charges) {
    if (c.status === CHARGE_STATUS.PAID) continue;
    const k = String(c.tenancyId);
    dueByTenancy.set(k, (dueByTenancy.get(k) ?? 0) + (c.amount - c.paidAmount));
  }

  // Per tenant: this month's service charge + any outstanding charge.
  const chargesByTenancy = new Map<string, typeof charges>();
  for (const c of charges) {
    const isThisMonthSC =
      c.monthYear === monthYear &&
      c.category === CHARGE_CATEGORY.SERVICE_CHARGE;
    const isOutstanding = c.status !== CHARGE_STATUS.PAID;
    // Keep a cleared due visible on the month its amount was adjusted so the
    // edit (e.g. a cancellation) is documented even at zero remaining.
    const adjustedThisMonth = (c.adjustments ?? []).some(
      (a) => a.monthYear === monthYear,
    );
    if (!isThisMonthSC && !isOutstanding && !adjustedThisMonth) continue;
    const key = String(c.tenancyId);
    const list = chargesByTenancy.get(key) ?? [];
    list.push(c);
    chargesByTenancy.set(key, list);
  }

  const rows = roster
    .map((r) => ({
      key: r.tenancyId,
      label: `${r.unitLabel} · ${r.tenantName}`,
      isPastTenant: r.isPastForMonth,
      paid: paidByTenancy.get(r.tenancyId) ?? 0,
      due: dueByTenancy.get(r.tenancyId) ?? 0,
      charges: (chargesByTenancy.get(r.tenancyId) ?? []).map((c) => ({
        id: String(c._id),
        description: c.description,
        monthYear: c.monthYear,
        fromOtherMonth: c.monthYear !== monthYear,
        paidAmount: c.paidAmount,
        amount: c.amount,
        adjustments: (c.adjustments ?? [])
          .filter((a) => a.monthYear <= monthYear)
          .map((a) => ({
            prevAmount: a.prevAmount,
            amount: a.amount,
            monthYear: a.monthYear,
            by: a.by ?? null,
          })),
      })),
    }))
    .sort((a, b) =>
      compareUnitLabels(a.label.split(" · ")[0], b.label.split(" · ")[0]),
    );

  return {
    buildingName: building?.name ?? "",
    buildingAddress: building?.address ?? null,
    monthYear,
    status: period.status,
    openingBalance: period.openingBalance,
    closingBalance: period.closingBalance ?? null,
    prevNote,
    prevNoteMonth,
    note: period.note?.trim() ? period.note.trim() : null,
    rows,
    incomes: incomes.map((i) => ({
      id: String(i._id),
      date: shortDate(i.receivedAt ?? i.createdAt),
      description: i.description,
      source: i.source,
      amount: i.amount,
    })),
    expenses: expenses.map((e) => {
      const paid = expensePaidAsOf(e, monthYear);
      const outstanding = e.amount - paid;
      return {
        id: String(e._id),
        date: shortDate(e.paidAt ?? e.createdAt),
        voucherNo: e.voucherNo,
        description: e.description,
        status:
          outstanding <= 0
            ? EXPENSE_STATUS.PAID
            : paid > 0
              ? EXPENSE_STATUS.PARTIAL
              : EXPENSE_STATUS.DUE,
        amount: e.amount,
        paidAmount: paid,
        paidThisMonth: expensePaidInMonth(e, monthYear),
        outstanding,
        fromMonth: e.monthYear !== monthYear ? e.monthYear : null,
      };
    }),
    withdrawals: withdrawals.map((w) => ({
      id: String(w._id),
      date: shortDate(w.takenAt ?? w.createdAt),
      takenBy: w.takenBy,
      note: w.note ?? null,
      amount: w.amount,
      returnedThisMonth: (w.returns ?? [])
        .filter((r) => r.monthYear === monthYear)
        .reduce((s, r) => s + r.amount, 0),
      outstanding: w.amount - withdrawalReturnedAsOf(w, monthYear),
      fromMonth: w.monthYear !== monthYear ? w.monthYear : null,
    })),
    totals,
    media: mediaDocs.map((m) => ({
      id: String(m._id),
      filename: m.filename ?? "",
      contentType: m.contentType ?? "image/jpeg",
      width: m.width ?? 0,
      height: m.height ?? 0,
      size: m.size ?? 0,
      uploadedByName: m.uploadedByName ?? "",
      createdAt: m.createdAt ? shortDate(m.createdAt) : "",
    })),
  };
}
