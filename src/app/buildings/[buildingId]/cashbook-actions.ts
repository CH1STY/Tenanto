"use server";

import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Tenancy } from "@/models/Tenancy";
import { Unit } from "@/models/Unit";
import { User } from "@/models/User";
import { Charge } from "@/models/Charge";
import { Income } from "@/models/Income";
import { Expense } from "@/models/Expense";
import { Withdrawal } from "@/models/Withdrawal";
import { Payment } from "@/models/Payment";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { getPeriodTotals } from "@/lib/ledger";
import { shortDate } from "@/lib/dates";
import { compareUnitLabels } from "@/lib/units";
import { CHARGE_CATEGORY, CHARGE_STATUS } from "@/lib/constants";
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

  const tenancies = await Tenancy.find({ buildingId, isActive: true }).lean();
  const [
    building,
    units,
    users,
    charges,
    incomes,
    expenses,
    withdrawals,
    payments,
    totals,
    prevPeriod,
  ] = await Promise.all([
    Building.findById(buildingId).select("name").lean(),
    Unit.find({ buildingId }).lean(),
    User.find({ _id: { $in: tenancies.map((t) => t.userId) } }).lean(),
    Charge.find({ tenancyId: { $in: tenancies.map((t) => t._id) } })
      .sort({ monthYear: 1 })
      .lean(),
    Income.find({ buildingId, monthYear }).sort({ receivedAt: 1 }).lean(),
    Expense.find({ buildingId, monthYear }).sort({ voucherNo: 1 }).lean(),
    Withdrawal.find({ buildingId, monthYear }).sort({ takenAt: 1 }).lean(),
    Payment.find({ buildingId, monthYear }).lean(),
    getPeriodTotals(buildingId, monthYear),
    MonthlyPeriod.findOne({ buildingId, monthYear: { $lt: monthYear } })
      .sort({ monthYear: -1 })
      .select("monthYear note")
      .lean(),
  ]);

  const prevNote = prevPeriod?.note?.trim() ? prevPeriod.note.trim() : null;
  const prevNoteMonth = prevPeriod?.monthYear ?? null;

  const unitLabel = new Map(units.map((u) => [String(u._id), u.label]));
  const userName = new Map(users.map((u) => [String(u._id), u.name]));

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
    if (!isThisMonthSC && !isOutstanding) continue;
    const key = String(c.tenancyId);
    const list = chargesByTenancy.get(key) ?? [];
    list.push(c);
    chargesByTenancy.set(key, list);
  }

  const rows = tenancies
    .map((t) => ({
      key: String(t._id),
      label: `${unitLabel.get(String(t.unitId)) ?? "?"} · ${
        userName.get(String(t.userId)) ?? "Tenant"
      }`,
      paid: paidByTenancy.get(String(t._id)) ?? 0,
      due: dueByTenancy.get(String(t._id)) ?? 0,
      charges: (chargesByTenancy.get(String(t._id)) ?? []).map((c) => ({
        id: String(c._id),
        description: c.description,
        monthYear: c.monthYear,
        fromOtherMonth: c.monthYear !== monthYear,
        paidAmount: c.paidAmount,
        amount: c.amount,
      })),
    }))
    .sort((a, b) =>
      compareUnitLabels(a.label.split(" · ")[0], b.label.split(" · ")[0]),
    );

  return {
    buildingName: building?.name ?? "",
    monthYear,
    status: period.status,
    openingBalance: period.openingBalance,
    closingBalance: period.closingBalance ?? null,
    prevNote,
    prevNoteMonth,
    rows,
    incomes: incomes.map((i) => ({
      id: String(i._id),
      date: shortDate(i.receivedAt ?? i.createdAt),
      description: i.description,
      source: i.source,
      amount: i.amount,
    })),
    expenses: expenses.map((e) => ({
      id: String(e._id),
      date: shortDate(e.paidAt ?? e.createdAt),
      voucherNo: e.voucherNo,
      description: e.description,
      status: e.status,
      amount: e.amount,
    })),
    withdrawals: withdrawals.map((w) => ({
      id: String(w._id),
      date: shortDate(w.takenAt ?? w.createdAt),
      takenBy: w.takenBy,
      note: w.note ?? null,
      amount: w.amount,
    })),
    totals,
  };
}
