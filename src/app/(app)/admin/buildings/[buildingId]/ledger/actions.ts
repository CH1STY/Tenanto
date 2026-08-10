"use server";

import { revalidatePath } from "next/cache";

import { connectDB } from "@/lib/db";
import { requireRole, userManagesBuilding } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import {
  ROLES,
  AUDIT_ACTIONS,
  PERIOD_STATUS,
  CHARGE_CATEGORY,
  CHARGE_STATUS,
  EXPENSE_STATUS,
} from "@/lib/constants";
import {
  getPeriodTotals,
  computeClosing,
  recalcForwardChain,
} from "@/lib/ledger";
import { resolveTransactionDate, monthLabel } from "@/lib/dates";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { Tenancy } from "@/models/Tenancy";
import { Unit } from "@/models/Unit";
import { User } from "@/models/User";
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
  withdrawalReturnSchema,
  expensePaySchema,
  addChargeSchema,
  editChargeSchema,
  chargeRefSchema,
  closeMonthSchema,
  monthNoteSchema,
  openingBalanceAdjustSchema,
  ledgerEntrySchema,
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

async function superAdminOrNull() {
  try {
    return await requireRole(ROLES.SUPER_ADMIN);
  } catch {
    return null;
  }
}

function actorInfo(a: { id: string; name?: string | null; role: string }) {
  return { id: a.id, name: a.name, role: a.role };
}

async function requireOpenPeriod(buildingId: string, monthYear: string) {
  if (!(await userManagesBuilding(buildingId))) {
    return { error: "You do not manage this building." as const, period: null };
  }
  const period = await MonthlyPeriod.findOne({ buildingId, monthYear });
  if (!period)
    return { error: "That month is not open." as const, period: null };
  if (period.status !== PERIOD_STATUS.OPEN) {
    return { error: "That month is closed." as const, period: null };
  }
  return { error: null, period };
}

export async function openMonth(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await superAdminOrNull();
  if (!actor) return fail("Only a Super Admin can open a month.");

  const parsed = openMonthSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    serviceChargeAmount: formData.get("serviceChargeAmount"),
    openingBalance: formData.get("openingBalance"),
  });
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");

  const { buildingId, monthYear, serviceChargeAmount, openingBalance } =
    parsed.data;

  await connectDB();

  if (!(await userManagesBuilding(buildingId))) {
    return fail("You do not manage this building.");
  }

  const existing = await MonthlyPeriod.findOne({
    buildingId,
    monthYear,
  }).lean();
  if (existing) return fail("That month has already been opened.");

  // Only one month may be OPEN at a time; everything else stays locked.
  const openElsewhere = await MonthlyPeriod.findOne({
    buildingId,
    status: PERIOD_STATUS.OPEN,
  }).lean();
  if (openElsewhere) {
    return fail(
      `Close ${monthLabel(openElsewhere.monthYear)} first — only one month can be open at a time.`,
    );
  }

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

  // Snapshot the active tenants at open time so this month's roster is frozen
  // permanently, independent of any later tenancy assignment or date edits.
  const activeTenancies = await Tenancy.find({
    buildingId,
    isActive: true,
  }).lean();

  const [rosterUnits, rosterUsers] = await Promise.all([
    Unit.find({ _id: { $in: activeTenancies.map((t) => t.unitId) } })
      .select("label")
      .lean(),
    User.find({ _id: { $in: activeTenancies.map((t) => t.userId) } })
      .select("name")
      .lean(),
  ]);
  const rosterUnitLabel = new Map(
    rosterUnits.map((u) => [String(u._id), u.label]),
  );
  const rosterTenantName = new Map(
    rosterUsers.map((u) => [String(u._id), u.name]),
  );
  const roster = activeTenancies.map((t) => ({
    tenancyId: t._id,
    userId: t.userId,
    unitId: t.unitId,
    unitLabel: rosterUnitLabel.get(String(t.unitId)) ?? "",
    tenantName: rosterTenantName.get(String(t.userId)) ?? "",
  }));

  const period = await MonthlyPeriod.create({
    buildingId,
    monthYear,
    openingBalance: opening,
    serviceChargeAmount,
    status: PERIOD_STATUS.OPEN,
    roster,
  });

  // Raise a SERVICE_CHARGE for every active tenancy at amount N.
  if (activeTenancies.length > 0 && serviceChargeAmount > 0) {
    await Charge.insertMany(
      activeTenancies.map((t) => ({
        buildingId,
        tenancyId: t._id,
        userId: t.userId,
        monthYear,
        category: CHARGE_CATEGORY.SERVICE_CHARGE,
        description: `Service charge — ${monthLabel(monthYear)}`,
        amount: serviceChargeAmount,
        paidAmount: 0,
        status: CHARGE_STATUS.DUE,
      })),
      { ordered: false },
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

export async function updateMonthNote(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = monthNoteSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    note: formData.get("note"),
  });
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, note } = parsed.data;

  await connectDB();
  const { error, period } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  period!.note = note && note.length ? note : null;
  await period!.save();

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "MonthlyPeriod",
    entityId: String(period!._id),
    entityLabel: monthYear,
    buildingId,
    actor: actorInfo(actor),
    description: `Updated note for ${monthYear}.`,
    after: { note: period!.note },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

export async function adjustOpeningBalance(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = openingBalanceAdjustSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    openingBalance: formData.get("openingBalance"),
  });
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");

  const { buildingId, monthYear, openingBalance } = parsed.data;

  await connectDB();
  const { error, period } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  const previous = await MonthlyPeriod.findOne({
    buildingId,
    monthYear: { $lt: monthYear },
  })
    .sort({ monthYear: -1 })
    .select("monthYear")
    .lean();

  if (previous) {
    return fail(
      `Opening cash can only be adjusted for the first month. Found previous month ${previous.monthYear}.`,
    );
  }

  const beforeOpening = period!.openingBalance;
  period!.openingBalance = openingBalance;
  await period!.save();

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "MonthlyPeriod",
    entityId: String(period!._id),
    entityLabel: monthYear,
    buildingId,
    actor: actorInfo(actor),
    description: `Adjusted opening cash in hand for ${monthYear} to ${openingBalance}.`,
    before: { openingBalance: beforeOpening },
    after: { openingBalance },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

export async function recordPayment(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = payChargeSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    chargeId: formData.get("chargeId"),
    amount: formData.get("amount"),
  });
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, chargeId, amount } = parsed.data;

  const txnDate = resolveTransactionDate(
    monthYear,
    formData.get("date") as string | null,
  );
  if (!txnDate.ok) return fail(txnDate.error);

  await connectDB();
  const { error } = await requireOpenPeriod(buildingId, monthYear);
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
    allocations: [{ chargeId: charge._id, category: charge.category, amount }],
    receivedAt: txnDate.date,
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
  formData: FormData,
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
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, source, description, amount } = parsed.data;

  const txnDate = resolveTransactionDate(
    monthYear,
    formData.get("date") as string | null,
  );
  if (!txnDate.ok) return fail(txnDate.error);

  await connectDB();
  const { error } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  const income = await Income.create({
    buildingId,
    monthYear,
    source,
    description,
    amount,
    receivedAt: txnDate.date,
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
  formData: FormData,
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
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, category, description, amount, status } =
    parsed.data;

  const txnDate = resolveTransactionDate(
    monthYear,
    formData.get("date") as string | null,
  );
  if (!txnDate.ok) return fail(txnDate.error);

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

  const paidNow = status === EXPENSE_STATUS.PAID ? amount : 0;

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
      paidAmount: paidNow,
      payments:
        paidNow > 0 ? [{ amount: paidNow, monthYear, at: txnDate.date }] : [],
      paidAt: paidNow > 0 ? txnDate.date : null,
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
        paidAt: txnDate.date,
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
  formData: FormData,
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
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, takenBy, amount, note } = parsed.data;

  const txnDate = resolveTransactionDate(
    monthYear,
    formData.get("date") as string | null,
  );
  if (!txnDate.ok) return fail(txnDate.error);

  await connectDB();
  const { error } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  const wd = await Withdrawal.create({
    buildingId,
    monthYear,
    takenBy,
    amount,
    note: note || null,
    takenAt: txnDate.date,
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

export async function addCharge(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = addChargeSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    tenancyId: formData.get("tenancyId"),
    category: formData.get("category"),
    description: formData.get("description"),
    amount: formData.get("amount"),
  });
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, tenancyId, category, description, amount } =
    parsed.data;

  await connectDB();
  const { error } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  const tenancy = await Tenancy.findOne({ _id: tenancyId, buildingId }).lean();
  if (!tenancy) return fail("Tenant not found in this building.");

  const charge = await Charge.create({
    buildingId,
    tenancyId,
    userId: tenancy.userId,
    monthYear,
    category,
    description,
    amount,
    paidAmount: 0,
    status: CHARGE_STATUS.DUE,
  });

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "Charge",
    entityId: String(charge._id),
    entityLabel: description,
    buildingId,
    actor: actorInfo(actor),
    description: `Raised ${category} ${amount} on a tenant: "${description}".`,
    after: { category, description, amount },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

/**
 * Adjust dues in the open month view.
 * Managers may adjust only this month's dues; SuperAdmins may also adjust
 * earlier-month dues that are still outstanding.
 */
export async function editCharge(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = editChargeSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    chargeId: formData.get("chargeId"),
    description: formData.get("description"),
    amount: formData.get("amount"),
  });
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, chargeId, description, amount } = parsed.data;

  await connectDB();
  const { error } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  const charge = await Charge.findOne({ _id: chargeId, buildingId });
  if (!charge) return fail("Due not found.");
  const isCurrentMonthCharge = charge.monthYear === monthYear;
  if (!isCurrentMonthCharge && actor.role !== ROLES.SUPER_ADMIN) {
    return fail("Only a Super Admin can adjust dues from previous months.");
  }
  if (charge.category === CHARGE_CATEGORY.SERVICE_CHARGE) {
    return fail(
      "Service charge is fixed for the month and can't be adjusted here.",
    );
  }
  if (amount < charge.paidAmount) {
    return fail(`Amount can't be below the ${charge.paidAmount} already paid.`);
  }

  const before = { description: charge.description, amount: charge.amount };
  charge.description = description;
  charge.amount = amount;
  charge.status =
    charge.paidAmount <= 0
      ? CHARGE_STATUS.DUE
      : charge.paidAmount >= amount
        ? CHARGE_STATUS.PAID
        : CHARGE_STATUS.PARTIAL;
  await charge.save();

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "Charge",
    entityId: String(charge._id),
    entityLabel: description,
    buildingId,
    actor: actorInfo(actor),
    description: `Adjusted ${isCurrentMonthCharge ? "current" : "previous"}-month due to "${description}" (${amount}).`,
    before,
    after: { description, amount },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

/**
 * Delete a due with no payments against it.
 * Managers: current-month only. SuperAdmins: current or previous-month dues.
 */
export async function removeCharge(formData: FormData) {
  const actor = await actorOrNull();
  if (!actor) return;

  const parsed = chargeRefSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    chargeId: formData.get("chargeId"),
  });
  if (!parsed.success) return;
  const { buildingId, monthYear, chargeId } = parsed.data;

  await connectDB();
  const { error } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return;

  const charge = await Charge.findOne({ _id: chargeId, buildingId });
  if (!charge) return;
  const isCurrentMonthCharge = charge.monthYear === monthYear;
  if (!isCurrentMonthCharge && actor.role !== ROLES.SUPER_ADMIN) return;
  if (charge.paidAmount > 0) return;

  const label = charge.description;
  await charge.deleteOne();

  await logAudit({
    action: AUDIT_ACTIONS.DELETE,
    entity: "Charge",
    entityId: chargeId,
    entityLabel: label,
    buildingId,
    actor: actorInfo(actor),
    description: `Deleted ${isCurrentMonthCharge ? "current" : "previous"}-month due "${label}".`,
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
}

/** Parse + authorize a delete/reverse request against an OPEN period. */
async function requireDeletable(formData: FormData) {
  const actor = await actorOrNull();
  if (!actor) return { error: "Not authorized." as const };

  const parsed = ledgerEntrySchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    id: formData.get("id"),
  });
  if (!parsed.success) return { error: "Invalid input." as const };

  await connectDB();
  const { error } = await requireOpenPeriod(
    parsed.data.buildingId,
    parsed.data.monthYear,
  );
  if (error) return { error };

  return { actor, ...parsed.data };
}

export async function deleteIncome(formData: FormData) {
  const ctx = await requireDeletable(formData);
  if ("error" in ctx) return;
  const { actor, buildingId, monthYear, id } = ctx;

  const income = await Income.findOneAndDelete({
    _id: id,
    buildingId,
    monthYear,
  });
  if (!income) return;

  await logAudit({
    action: AUDIT_ACTIONS.DELETE,
    entity: "Income",
    entityId: id,
    entityLabel: income.description,
    buildingId,
    actor: actorInfo(actor),
    description: `Deleted income ${income.amount} (${income.source}): "${income.description}".`,
    before: {
      source: income.source,
      description: income.description,
      amount: income.amount,
    },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
}

export async function deleteExpense(formData: FormData) {
  const ctx = await requireDeletable(formData);
  if ("error" in ctx) return;
  const { actor, buildingId, monthYear, id } = ctx;

  const expense = await Expense.findOne({ _id: id, buildingId, monthYear });
  if (!expense) return;
  // Deleting removes the row and its embedded payments; block it when a payment
  // was logged in another (possibly closed) month so that month isn't altered.
  if ((expense.payments ?? []).some((p) => p.monthYear !== monthYear)) return;

  await expense.deleteOne();

  await logAudit({
    action: AUDIT_ACTIONS.DELETE,
    entity: "Expense",
    entityId: id,
    entityLabel: `V#${expense.voucherNo} ${expense.description}`,
    buildingId,
    actor: actorInfo(actor),
    description: `Deleted ${expense.status} expense ${expense.amount} (V#${expense.voucherNo}): "${expense.description}".`,
    before: {
      voucherNo: expense.voucherNo,
      description: expense.description,
      amount: expense.amount,
      status: expense.status,
    },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
}

export async function payExpense(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = expensePaySchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    id: formData.get("id"),
    amount: formData.get("amount"),
  });
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, id, amount } = parsed.data;

  const txnDate = resolveTransactionDate(
    monthYear,
    formData.get("date") as string | null,
  );
  if (!txnDate.ok) return fail(txnDate.error);

  await connectDB();
  const { error } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  const expense = await Expense.findOne({ _id: id, buildingId });
  if (!expense) return fail("Expense not found.");

  const paid = expense.paidAmount ?? 0;
  const outstanding = expense.amount - paid;
  if (outstanding <= 0) return fail("This expense is already fully paid.");
  if (amount > outstanding) {
    return fail(`Amount exceeds the outstanding ${outstanding} to pay.`);
  }

  expense.paidAmount = paid + amount;
  expense.payments.push({ amount, monthYear, at: txnDate.date });
  expense.status =
    expense.paidAmount >= expense.amount
      ? EXPENSE_STATUS.PAID
      : EXPENSE_STATUS.PARTIAL;
  if (expense.paidAmount >= expense.amount) expense.paidAt = txnDate.date;
  await expense.save();

  const stillOwed = expense.amount - expense.paidAmount;
  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "Expense",
    entityId: String(expense._id),
    entityLabel: `V#${expense.voucherNo} ${expense.description}`,
    buildingId,
    actor: actorInfo(actor),
    description: `Paid ${amount} on expense (V#${expense.voucherNo}) "${expense.description}"${
      stillOwed > 0 ? ` (${stillOwed} still due)` : " (fully paid)"
    }.`,
    after: { paid: amount, paidAmount: expense.paidAmount },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

export async function returnWithdrawal(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = withdrawalReturnSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    id: formData.get("id"),
    amount: formData.get("amount"),
  });
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { buildingId, monthYear, id, amount } = parsed.data;

  const txnDate = resolveTransactionDate(
    monthYear,
    formData.get("date") as string | null,
  );
  if (!txnDate.ok) return fail(txnDate.error);

  await connectDB();
  const { error } = await requireOpenPeriod(buildingId, monthYear);
  if (error) return fail(error);

  const wd = await Withdrawal.findOne({ _id: id, buildingId });
  if (!wd) return fail("Withdrawal not found.");

  const outstanding = wd.amount - (wd.returnedAmount ?? 0);
  if (amount > outstanding) {
    return fail(`Amount exceeds the outstanding ${outstanding} to return.`);
  }

  wd.returnedAmount = (wd.returnedAmount ?? 0) + amount;
  wd.returns.push({ amount, monthYear, at: txnDate.date });
  await wd.save();

  const stillOwed = wd.amount - wd.returnedAmount;
  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "Withdrawal",
    entityId: String(wd._id),
    entityLabel: wd.takenBy,
    buildingId,
    actor: actorInfo(actor),
    description: `${wd.takenBy} returned ${amount} to the building${
      stillOwed > 0 ? ` (${stillOwed} still outstanding)` : " (fully repaid)"
    }.`,
    after: { returned: amount, returnedAmount: wd.returnedAmount },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

export async function deleteWithdrawal(formData: FormData) {
  const ctx = await requireDeletable(formData);
  if ("error" in ctx) return;
  const { actor, buildingId, monthYear, id } = ctx;

  const wd = await Withdrawal.findOne({ _id: id, buildingId, monthYear });
  if (!wd) return;
  // Deleting removes the row and its embedded returns; block it when a return
  // was logged in another (possibly closed) month so that month isn't altered.
  if ((wd.returns ?? []).some((r) => r.monthYear !== monthYear)) return;

  await wd.deleteOne();

  await logAudit({
    action: AUDIT_ACTIONS.DELETE,
    entity: "Withdrawal",
    entityId: id,
    entityLabel: wd.takenBy,
    buildingId,
    actor: actorInfo(actor),
    description: `Deleted withdrawal ${wd.amount} by ${wd.takenBy}.`,
    before: { takenBy: wd.takenBy, amount: wd.amount, note: wd.note },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
}

/** Undo the most recent return on a withdrawal (only one recorded this month). */
export async function reverseWithdrawalReturn(formData: FormData) {
  const ctx = await requireDeletable(formData);
  if ("error" in ctx) return;
  const { actor, buildingId, monthYear, id } = ctx;

  const wd = await Withdrawal.findOne({ _id: id, buildingId });
  if (!wd) return;
  const last = wd.returns[wd.returns.length - 1];
  // Only undo a return that was recorded in the month being edited.
  if (!last || last.monthYear !== monthYear) return;

  wd.returns.pop();
  wd.returnedAmount = Math.max(0, (wd.returnedAmount ?? 0) - last.amount);
  await wd.save();

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "Withdrawal",
    entityId: id,
    entityLabel: wd.takenBy,
    buildingId,
    actor: actorInfo(actor),
    description: `Undid a return of ${last.amount} by ${wd.takenBy}.`,
    after: { returnedAmount: wd.returnedAmount },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
}

/** Undo the most recent payment on an expense (only one recorded this month). */
export async function reverseExpensePayment(formData: FormData) {
  const ctx = await requireDeletable(formData);
  if ("error" in ctx) return;
  const { actor, buildingId, monthYear, id } = ctx;

  const expense = await Expense.findOne({ _id: id, buildingId });
  if (!expense) return;
  const last = expense.payments[expense.payments.length - 1];
  // Only undo a payment that was recorded in the month being edited.
  if (!last || last.monthYear !== monthYear) return;

  expense.payments.pop();
  expense.paidAmount = Math.max(0, (expense.paidAmount ?? 0) - last.amount);
  expense.status =
    expense.paidAmount <= 0
      ? EXPENSE_STATUS.DUE
      : expense.paidAmount >= expense.amount
        ? EXPENSE_STATUS.PAID
        : EXPENSE_STATUS.PARTIAL;
  if (expense.paidAmount < expense.amount) expense.paidAt = null;
  await expense.save();

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "Expense",
    entityId: id,
    entityLabel: `V#${expense.voucherNo} ${expense.description}`,
    buildingId,
    actor: actorInfo(actor),
    description: `Undid a payment of ${last.amount} on expense (V#${expense.voucherNo}) "${expense.description}".`,
    after: { paidAmount: expense.paidAmount, status: expense.status },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
}

/** Reverse a payment: restore each allocated charge's paidAmount + status, then delete it. */
export async function reversePayment(formData: FormData) {
  const ctx = await requireDeletable(formData);
  if ("error" in ctx) return;
  const { actor, buildingId, monthYear, id } = ctx;

  const payment = await Payment.findOne({ _id: id, buildingId, monthYear });
  if (!payment) return;

  for (const alloc of payment.allocations) {
    const charge = await Charge.findById(alloc.chargeId);
    if (!charge) continue;
    charge.paidAmount = Math.max(0, charge.paidAmount - alloc.amount);
    charge.status =
      charge.paidAmount <= 0
        ? CHARGE_STATUS.DUE
        : charge.paidAmount >= charge.amount
          ? CHARGE_STATUS.PAID
          : CHARGE_STATUS.PARTIAL;
    await charge.save();
  }

  await payment.deleteOne();

  await logAudit({
    action: AUDIT_ACTIONS.DELETE,
    entity: "Payment",
    entityId: id,
    entityLabel: String(payment.totalAmount),
    buildingId,
    actor: actorInfo(actor),
    description: `Reversed payment of ${payment.totalAmount}; restored ${payment.allocations.length} charge(s).`,
    before: {
      totalAmount: payment.totalAmount,
      allocations: payment.allocations,
    },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
}

export async function closeMonth(formData: FormData) {
  const actor = await requireRole(ROLES.SUPER_ADMIN);

  const parsed = closeMonthSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
  });
  if (!parsed.success) return;
  const { buildingId, monthYear } = parsed.data;

  await connectDB();
  if (!(await userManagesBuilding(buildingId))) return;
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
      { $set: { carriedFrom: monthYear } },
    ),
    Expense.updateMany(
      { buildingId, monthYear, status: EXPENSE_STATUS.DUE, carriedFrom: null },
      { $set: { carriedFrom: monthYear } },
    ),
  ]);

  period.status = PERIOD_STATUS.CLOSED;
  period.closingBalance = closing;
  period.closedAt = new Date();
  period.closedBy = actor.id as unknown as typeof period.closedBy;
  await period.save();

  // A reopened previous month can change every later month's opening/closing.
  await recalcForwardChain(buildingId, monthYear, closing);

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

/**
 * Reopen a previously closed month for corrections. Allowed only when no other
 * month is open (single-open rule); closing it again re-cascades later months.
 */
export async function reopenMonth(formData: FormData) {
  const actor = await requireRole(ROLES.SUPER_ADMIN);

  const parsed = closeMonthSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
  });
  if (!parsed.success) return;
  const { buildingId, monthYear } = parsed.data;

  await connectDB();
  if (!(await userManagesBuilding(buildingId))) return;

  const openElsewhere = await MonthlyPeriod.findOne({
    buildingId,
    status: PERIOD_STATUS.OPEN,
  }).lean();
  if (openElsewhere) return; // another month is open — locked

  const period = await MonthlyPeriod.findOne({ buildingId, monthYear });
  if (!period || period.status !== PERIOD_STATUS.CLOSED) return;

  period.status = PERIOD_STATUS.OPEN;
  period.closingBalance = null;
  period.closedAt = null;
  period.closedBy = null;
  await period.save();

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "MonthlyPeriod",
    entityId: String(period._id),
    entityLabel: monthYear,
    buildingId,
    actor: actorInfo(actor),
    description: `Reopened month ${monthYear} for corrections.`,
    before: { status: PERIOD_STATUS.CLOSED },
    after: { status: PERIOD_STATUS.OPEN },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
}

/**
 * Delete a month entirely — its payments, income, expenses, withdrawals and
 * charges — then re-cascade the opening/closing balances of every later month.
 */
export async function deleteMonth(formData: FormData) {
  const actor = await requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER);

  const parsed = closeMonthSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
  });
  if (!parsed.success) return;
  const { buildingId, monthYear } = parsed.data;

  await connectDB();
  if (!(await userManagesBuilding(buildingId))) return;

  const period = await MonthlyPeriod.findOne({ buildingId, monthYear });
  if (!period) return;

  // Reverse this month's payments so charges from other months are restored.
  const payments = await Payment.find({ buildingId, monthYear });
  for (const p of payments) {
    for (const alloc of p.allocations) {
      const charge = await Charge.findById(alloc.chargeId);
      if (!charge) continue;
      charge.paidAmount = Math.max(0, charge.paidAmount - alloc.amount);
      charge.status =
        charge.paidAmount <= 0
          ? CHARGE_STATUS.DUE
          : charge.paidAmount >= charge.amount
            ? CHARGE_STATUS.PAID
            : CHARGE_STATUS.PARTIAL;
      await charge.save();
    }
  }

  await Promise.all([
    Payment.deleteMany({ buildingId, monthYear }),
    Income.deleteMany({ buildingId, monthYear }),
    Expense.deleteMany({ buildingId, monthYear }),
    Withdrawal.deleteMany({ buildingId, monthYear }),
    Charge.deleteMany({ buildingId, monthYear }),
  ]);
  await period.deleteOne();

  // Re-chain later months from the closest surviving neighbour.
  const prev = await MonthlyPeriod.findOne({
    buildingId,
    monthYear: { $lt: monthYear },
  })
    .sort({ monthYear: -1 })
    .lean();
  const anchor =
    prev ??
    (await MonthlyPeriod.findOne({ buildingId, monthYear: { $gt: monthYear } })
      .sort({ monthYear: 1 })
      .lean());
  if (anchor) {
    const anchorTotals = await getPeriodTotals(buildingId, anchor.monthYear);
    const anchorClosing =
      anchor.status === PERIOD_STATUS.CLOSED && anchor.closingBalance != null
        ? anchor.closingBalance
        : computeClosing(anchor.openingBalance, anchorTotals);
    await recalcForwardChain(buildingId, anchor.monthYear, anchorClosing);
  }

  await logAudit({
    action: AUDIT_ACTIONS.DELETE,
    entity: "MonthlyPeriod",
    entityId: String(period._id),
    entityLabel: monthYear,
    buildingId,
    actor: actorInfo(actor),
    description: `Deleted month ${monthYear} and all its transactions; recalculated later months.`,
    before: { status: period.status, closingBalance: period.closingBalance },
  });

  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
}
