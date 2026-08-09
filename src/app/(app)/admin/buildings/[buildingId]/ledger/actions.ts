"use server";

import { revalidatePath } from "next/cache";

import { connectDB } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import {
  ROLES,
  AUDIT_ACTIONS,
  PERIOD_STATUS,
  CHARGE_CATEGORY,
  CHARGE_STATUS,
  EXPENSE_STATUS,
} from "@/lib/constants";
import { getPeriodTotals, computeClosing } from "@/lib/ledger";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { Tenancy } from "@/models/Tenancy";
import { Charge } from "@/models/Charge";
import { Payment } from "@/models/Payment";
import { Income } from "@/models/Income";
import { Expense } from "@/models/Expense";
import { Withdrawal } from "@/models/Withdrawal";
import {
  openMonthSchema,
  payChargeSchema,
  incomeSchema,
  expenseSchema,
  withdrawalSchema,
  closeMonthSchema,
} from "@/lib/validators/ledger";

export type ActionState = { error: string | null; ok?: boolean };
const OK: ActionState = { error: null, ok: true };
const fail = (error: string): ActionState => ({ error, ok: false });

async function actorOrNull() {
  try {
    return await requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER);
  } catch {
    return null;
  }
}

function actorInfo(a: { id: string; name?: string | null; role: string }) {
  return { id: a.id, name: a.name, role: a.role };
}

async function requireOpenPeriod(buildingId: string, monthYear: string) {
  const period = await MonthlyPeriod.findOne({ buildingId, monthYear });
  if (!period) return { error: "That month is not open." as const, period: null };
  if (period.status !== PERIOD_STATUS.OPEN) {
    return { error: "That month is closed." as const, period: null };
  }
  return { error: null, period };
}

export async function openMonth(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = openMonthSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    serviceChargeAmount: formData.get("serviceChargeAmount"),
    openingBalance: formData.get("openingBalance"),
  });
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input.");

  const { buildingId, monthYear, serviceChargeAmount, openingBalance } =
    parsed.data;

  await connectDB();

  const existing = await MonthlyPeriod.findOne({ buildingId, monthYear }).lean();
  if (existing) return fail("That month has already been opened.");

  // Opening balance: previous month's closing if available, else manual.
  const prev = await MonthlyPeriod.findOne({
    buildingId,
    monthYear: { $lt: monthYear },
  })
    .sort({ monthYear: -1 })
    .lean();

  const opening =
    prev && prev.status === PERIOD_STATUS.CLOSED && prev.closingBalance != null
      ? prev.closingBalance
      : (openingBalance ?? 0);

  const period = await MonthlyPeriod.create({
    buildingId,
    monthYear,
    openingBalance: opening,
    serviceChargeAmount,
    status: PERIOD_STATUS.OPEN,
  });

  // Raise a SERVICE_CHARGE for every active tenancy at amount N.
  const activeTenancies = await Tenancy.find({
    buildingId,
    isActive: true,
  }).lean();

  if (activeTenancies.length > 0 && serviceChargeAmount > 0) {
    await Charge.insertMany(
      activeTenancies.map((t) => ({
        buildingId,
        tenancyId: t._id,
        userId: t.userId,
        monthYear,
        category: CHARGE_CATEGORY.SERVICE_CHARGE,
        description: `Service charge ${monthYear}`,
        amount: serviceChargeAmount,
        paidAmount: 0,
        status: CHARGE_STATUS.DUE,
      })),
      { ordered: false }
    );
  }

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "MonthlyPeriod",
    entityId: String(period._id),
    entityLabel: monthYear,
    buildingId,
    actor: actorInfo(actor),
    description: `Opened month ${monthYear} (service charge ${serviceChargeAmount}, opening ${opening}); raised ${activeTenancies.length} service charge(s).`,
    after: { monthYear, openingBalance: opening, serviceChargeAmount },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

export async function recordPayment(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = payChargeSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    chargeId: formData.get("chargeId"),
    amount: formData.get("amount"),
  });
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, chargeId, amount } = parsed.data;

  await connectDB();
  const { error, period } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  const charge = await Charge.findOne({ _id: chargeId, buildingId });
  if (!charge) return fail("Charge not found.");

  const remaining = charge.amount - charge.paidAmount;
  if (amount > remaining) {
    return fail(`Amount exceeds the outstanding ${remaining} on this charge.`);
  }

  charge.paidAmount += amount;
  charge.status =
    charge.paidAmount >= charge.amount
      ? CHARGE_STATUS.PAID
      : CHARGE_STATUS.PARTIAL;
  await charge.save();

  const payment = await Payment.create({
    buildingId,
    tenancyId: charge.tenancyId,
    userId: charge.userId,
    monthYear,
    totalAmount: amount,
    allocations: [
      { chargeId: charge._id, category: charge.category, amount },
    ],
    recordedBy: actor.id,
  });

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "Payment",
    entityId: String(payment._id),
    entityLabel: charge.description,
    buildingId,
    actor: actorInfo(actor),
    description: `Received ${amount} toward "${charge.description}".`,
    after: { amount, charge: charge.description, category: charge.category },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

export async function addIncome(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = incomeSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    source: formData.get("source"),
    description: formData.get("description"),
    amount: formData.get("amount"),
  });
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, source, description, amount } = parsed.data;

  await connectDB();
  const { error } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  const income = await Income.create({
    buildingId,
    monthYear,
    source,
    description,
    amount,
    recordedBy: actor.id,
  });

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "Income",
    entityId: String(income._id),
    entityLabel: description,
    buildingId,
    actor: actorInfo(actor),
    description: `Recorded income ${amount} (${source}): "${description}".`,
    after: { source, description, amount },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

export async function addExpense(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = expenseSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    category: formData.get("category") ?? undefined,
    description: formData.get("description"),
    amount: formData.get("amount"),
    status: formData.get("status"),
  });
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, category, description, amount, status } =
    parsed.data;

  await connectDB();
  const { error } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  // Auto voucher number, sequential per building + month. Retry once on race.
  async function nextVoucher() {
    const last = await Expense.findOne({ buildingId, monthYear })
      .sort({ voucherNo: -1 })
      .select("voucherNo")
      .lean();
    return (last?.voucherNo ?? 0) + 1;
  }

  let expense;
  try {
    expense = await Expense.create({
      buildingId,
      monthYear,
      voucherNo: await nextVoucher(),
      category: category || null,
      description,
      amount,
      status,
      paidAt: status === EXPENSE_STATUS.PAID ? new Date() : null,
      recordedBy: actor.id,
    });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      expense = await Expense.create({
        buildingId,
        monthYear,
        voucherNo: await nextVoucher(),
        category: category || null,
        description,
        amount,
        status,
        paidAt: status === EXPENSE_STATUS.PAID ? new Date() : null,
        recordedBy: actor.id,
      });
    } else {
      throw err;
    }
  }

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "Expense",
    entityId: String(expense._id),
    entityLabel: `V#${expense.voucherNo} ${description}`,
    buildingId,
    actor: actorInfo(actor),
    description: `Recorded ${status} expense ${amount} (V#${expense.voucherNo}): "${description}".`,
    after: { voucherNo: expense.voucherNo, description, amount, status },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

export async function addWithdrawal(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = withdrawalSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    takenBy: formData.get("takenBy"),
    amount: formData.get("amount"),
    note: formData.get("note"),
  });
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, takenBy, amount, note } = parsed.data;

  await connectDB();
  const { error } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  const wd = await Withdrawal.create({
    buildingId,
    monthYear,
    takenBy,
    amount,
    note: note || null,
    recordedBy: actor.id,
  });

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "Withdrawal",
    entityId: String(wd._id),
    entityLabel: takenBy,
    buildingId,
    actor: actorInfo(actor),
    description: `${takenBy} withdrew ${amount}${note ? ` (${note})` : ""}.`,
    after: { takenBy, amount, note: note || null },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

export async function closeMonth(formData: FormData) {
  const actor = await requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER);

  const parsed = closeMonthSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
  });
  if (!parsed.success) return;
  const { buildingId, monthYear } = parsed.data;

  await connectDB();
  const period = await MonthlyPeriod.findOne({ buildingId, monthYear });
  if (!period || period.status !== PERIOD_STATUS.OPEN) return;

  const totals = await getPeriodTotals(buildingId, monthYear);
  const closing = computeClosing(period.openingBalance, totals);

  // Tag unpaid service charges and DUE expenses as carried forward.
  await Promise.all([
    Charge.updateMany(
      {
        buildingId,
        monthYear,
        category: CHARGE_CATEGORY.SERVICE_CHARGE,
        status: { $ne: CHARGE_STATUS.PAID },
        carriedFrom: null,
      },
      { $set: { carriedFrom: monthYear } }
    ),
    Expense.updateMany(
      { buildingId, monthYear, status: EXPENSE_STATUS.DUE, carriedFrom: null },
      { $set: { carriedFrom: monthYear } }
    ),
  ]);

  period.status = PERIOD_STATUS.CLOSED;
  period.closingBalance = closing;
  period.closedAt = new Date();
  period.closedBy = actor.id as unknown as typeof period.closedBy;
  await period.save();

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "MonthlyPeriod",
    entityId: String(period._id),
    entityLabel: monthYear,
    buildingId,
    actor: actorInfo(actor),
    description: `Closed month ${monthYear}. Closing cash in hand ${closing}.`,
    before: { status: PERIOD_STATUS.OPEN },
    after: { status: PERIOD_STATUS.CLOSED, closingBalance: closing, ...totals },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
}
