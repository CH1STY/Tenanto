"use server";

import mongoose from "mongoose";
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
import { Building } from "@/models/Building";
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

// Tolerance for float sums of money (amounts are rounded to 2 decimals).
const MONEY_EPSILON = 1e-6;

/** Pipeline stage: recompute a charge's status from paidAmount/amount. */
const chargeStatusStage = {
  $set: {
    status: {
      $cond: [
        { $lte: ["$paidAmount", 0] },
        CHARGE_STATUS.DUE,
        {
          $cond: [
            { $gte: [{ $add: ["$paidAmount", MONEY_EPSILON] }, "$amount"] },
            CHARGE_STATUS.PAID,
            CHARGE_STATUS.PARTIAL,
          ],
        },
      ],
    },
  },
};

type Session = mongoose.ClientSession;

/** Thrown inside a transaction to abort it and return `message` as {error}. */
class ActionAbort extends Error {}

function isDuplicateKey(err: unknown) {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
}

/** Money as shown to users: at most 2 decimals, locale grouping. */
function showMoney(n: number) {
  return (Math.round(n * 100) / 100).toLocaleString();
}

/**
 * Run `fn` in a transaction (retried by the driver on write conflicts) and
 * return its result. Keep `fn` short and pass `session` to every operation.
 */
async function inTransaction<T>(fn: (session: Session) => Promise<T>) {
  const session = await mongoose.startSession();
  try {
    let out!: T;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out;
  } finally {
    await session.endSession();
  }
}

/**
 * Period lock. Every write into a month runs here: the transaction first
 * touches the month's OPEN period doc, so it write-conflicts with closeMonth
 * (which touches the same doc before computing totals) and they serialise —
 * nothing can land in a month after its closing balance was computed.
 * `fn` may throw ActionAbort to roll back and return a user-facing error.
 */
async function withOpenPeriod<T>(
  buildingId: string,
  monthYear: string,
  fn: (session: Session) => Promise<T>,
): Promise<{ error: string; value?: undefined } | { error: null; value: T }> {
  try {
    const value = await inTransaction(async (session) => {
      const lock = await MonthlyPeriod.updateOne(
        { buildingId, monthYear, status: PERIOD_STATUS.OPEN },
        { $set: { updatedAt: new Date() } },
        { session },
      );
      if (lock.matchedCount === 0) {
        const exists = await MonthlyPeriod.exists({
          buildingId,
          monthYear,
        }).session(session);
        throw new ActionAbort(
          exists ? "That month is closed." : "That month is not open.",
        );
      }
      return fn(session);
    });
    return { error: null, value };
  } catch (err) {
    if (err instanceof ActionAbort) return { error: err.message };
    throw err;
  }
}

/**
 * Atomically add `amount` to a charge's paidAmount — only if it doesn't
 * overpay — so two concurrent payments can never both pass the check.
 */
async function applyChargePayment(
  buildingId: string,
  chargeId: string,
  amount: number,
  session: Session,
) {
  const updated = await Charge.findOneAndUpdate(
    {
      _id: chargeId,
      buildingId,
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ["$paidAmount", 0] }, amount] },
          { $add: ["$amount", MONEY_EPSILON] },
        ],
      },
    },
    [
      {
        $set: {
          paidAmount: { $add: [{ $ifNull: ["$paidAmount", 0] }, amount] },
        },
      },
      chargeStatusStage,
    ],
    { returnDocument: "after", updatePipeline: true, session },
  );
  if (updated) return { charge: updated, error: null };

  const current = await Charge.findOne({ _id: chargeId, buildingId })
    .select("amount paidAmount")
    .session(session)
    .lean();
  if (!current) return { charge: null, error: "Charge not found." };
  const remaining = current.amount - (current.paidAmount ?? 0);
  return {
    charge: null,
    error: `Amount exceeds the outstanding ${showMoney(remaining)} on this charge.`,
  };
}

/**
 * Atomically take `amount` back off a charge's paidAmount (never below 0) and
 * recompute its status — used when a payment is reversed.
 */
async function undoChargePayment(
  chargeId: unknown,
  amount: number,
  session: Session,
) {
  await Charge.updateOne(
    { _id: chargeId },
    [
      {
        $set: {
          paidAmount: {
            $max: [
              0,
              { $subtract: [{ $ifNull: ["$paidAmount", 0] }, amount] },
            ],
          },
        },
      },
      chargeStatusStage,
    ],
    { updatePipeline: true, session },
  );
}

/** A logged payment/return entry on an expense or withdrawal. */
type LogEntry = { amount: number; monthYear: string; at?: Date | null };

/** Aggregation condition: element `el` (e.g. "$$el") equals `entry`. */
function entryMatches(el: string, entry: LogEntry) {
  return {
    $and: [
      { $eq: [`${el}.amount`, { $literal: entry.amount }] },
      { $eq: [`${el}.monthYear`, { $literal: entry.monthYear }] },
      { $eq: [{ $ifNull: [`${el}.at`, null] }, { $literal: entry.at ?? null }] },
    ],
  };
}

/** Aggregation expr: how many elements of `arrayPath` equal `entry`. */
function countEntries(arrayPath: string, entry: LogEntry) {
  return {
    $size: {
      $filter: {
        input: { $ifNull: [arrayPath, []] },
        as: "el",
        cond: entryMatches("$$el", entry),
      },
    },
  };
}

/** Aggregation expr: `arrayPath` without its LAST element equal to `entry`. */
function withoutLastEntry(arrayPath: string, entry: LogEntry) {
  const indexes = { $range: [0, { $size: "$$arr" }] };
  return {
    $let: {
      vars: { arr: { $ifNull: [arrayPath, []] } },
      in: {
        $let: {
          vars: {
            drop: {
              $max: {
                $filter: {
                  input: indexes,
                  as: "i",
                  cond: {
                    $let: {
                      vars: { el: { $arrayElemAt: ["$$arr", "$$i"] } },
                      in: entryMatches("$$el", entry),
                    },
                  },
                },
              },
            },
          },
          in: {
            $map: {
              input: {
                $filter: {
                  input: indexes,
                  as: "j",
                  cond: { $ne: ["$$j", "$$drop"] },
                },
              },
              as: "k",
              in: { $arrayElemAt: ["$$arr", "$$k"] },
            },
          },
        },
      },
    },
  };
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

  // One transaction that first touches the Building doc: concurrent opens (or
  // reopens) of this building write-conflict and are retried one at a time,
  // so the "one open month" check below can't be raced.
  let result;
  try {
    result = await inTransaction(async (session) => {
      await Building.updateOne(
        { _id: buildingId },
        { $set: { updatedAt: new Date() } },
        { session },
      );

      const existing = await MonthlyPeriod.findOne({ buildingId, monthYear })
        .session(session)
        .lean();
      if (existing) throw new ActionAbort("That month has already been opened.");

      // Only one month may be OPEN at a time; everything else stays locked.
      const openElsewhere = await MonthlyPeriod.findOne({
        buildingId,
        status: PERIOD_STATUS.OPEN,
      })
        .session(session)
        .lean();
      if (openElsewhere) {
        throw new ActionAbort(
          `Close ${monthLabel(openElsewhere.monthYear)} first — only one month can be open at a time.`,
        );
      }

      // Opening balance: previous month's closing if available, else manual.
      const prev = await MonthlyPeriod.findOne({
        buildingId,
        monthYear: { $lt: monthYear },
      })
        .sort({ monthYear: -1 })
        .session(session)
        .lean();

      const opening =
        prev &&
        prev.status === PERIOD_STATUS.CLOSED &&
        prev.closingBalance != null
          ? prev.closingBalance
          : (openingBalance ?? 0);

      // Snapshot the active tenants at open time so this month's roster is
      // frozen permanently, independent of later tenancy or date edits.
      const activeTenancies = await Tenancy.find({ buildingId, isActive: true })
        .session(session)
        .lean();
      const rosterUnits = await Unit.find({
        _id: { $in: activeTenancies.map((t) => t.unitId) },
      })
        .select("label")
        .session(session)
        .lean();
      const rosterUsers = await User.find({
        _id: { $in: activeTenancies.map((t) => t.userId) },
      })
        .select("name")
        .session(session)
        .lean();
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

      const [period] = await MonthlyPeriod.create(
        [
          {
            buildingId,
            monthYear,
            openingBalance: opening,
            serviceChargeAmount,
            status: PERIOD_STATUS.OPEN,
            roster,
          },
        ],
        { session },
      );

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
          { ordered: false, session },
        );
      }

      return { period, opening, activeTenancies };
    });
  } catch (err) {
    if (err instanceof ActionAbort) return fail(err.message);
    // Same month opened by a concurrent request.
    if (isDuplicateKey(err)) {
      return fail(`${monthLabel(monthYear)} has already been opened.`);
    }
    throw err;
  }
  const { period, opening, activeTenancies } = result;

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

  const newNote = note && note.length ? note : null;
  const res = await withOpenPeriod(buildingId, monthYear, (session) =>
    MonthlyPeriod.updateOne(
      { _id: period!._id },
      { $set: { note: newNote } },
      { session },
    ),
  );
  if (res.error !== null) return fail(res.error);

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "MonthlyPeriod",
    entityId: String(period!._id),
    entityLabel: monthYear,
    buildingId,
    actor: actorInfo(actor),
    description: `Updated note for ${monthYear}.`,
    after: { note: newNote },
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

  const res = await withOpenPeriod(buildingId, monthYear, async (session) => {
    const previous = await MonthlyPeriod.findOne({
      buildingId,
      monthYear: { $lt: monthYear },
    })
      .sort({ monthYear: -1 })
      .select("monthYear")
      .session(session)
      .lean();
    if (previous) {
      throw new ActionAbort(
        `Opening cash can only be adjusted for the first month. Found previous month ${previous.monthYear}.`,
      );
    }
    const old = await MonthlyPeriod.findOneAndUpdate(
      { _id: period!._id },
      { $set: { openingBalance } },
      { session, returnDocument: "before" },
    ).lean();
    return old?.openingBalance ?? period!.openingBalance;
  });
  if (res.error !== null) return fail(res.error);
  const beforeOpening = res.value;

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

  // The charge update and the Payment row commit (or roll back) together.
  const res = await withOpenPeriod(buildingId, monthYear, async (session) => {
    const applied = await applyChargePayment(
      buildingId,
      chargeId,
      amount,
      session,
    );
    if (!applied.charge) throw new ActionAbort(applied.error);
    const charge = applied.charge;
    const [payment] = await Payment.create(
      [
        {
          buildingId,
          tenancyId: charge.tenancyId,
          userId: charge.userId,
          monthYear,
          totalAmount: amount,
          allocations: [
            { chargeId: charge._id, category: charge.category, amount },
          ],
          receivedAt: txnDate.date,
          recordedBy: actor.id,
        },
      ],
      { session },
    );
    return { charge, payment };
  });
  if (res.error !== null) return fail(res.error);
  const { charge, payment } = res.value;

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

  const res = await withOpenPeriod(buildingId, monthYear, async (session) => {
    const [doc] = await Income.create(
      [
        {
          buildingId,
          monthYear,
          source,
          description,
          amount,
          receivedAt: txnDate.date,
          recordedBy: actor.id,
        },
      ],
      { session },
    );
    return doc;
  });
  if (res.error !== null) return fail(res.error);
  const income = res.value;

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

  // Auto voucher number, sequential per building + month.
  async function nextVoucher(session: Session) {
    const last = await Expense.findOne({ buildingId, monthYear })
      .sort({ voucherNo: -1 })
      .select("voucherNo")
      .session(session)
      .lean();
    return (last?.voucherNo ?? 0) + 1;
  }

  const paidNow = status === EXPENSE_STATUS.PAID ? amount : 0;

  // Same payload for every attempt; only the voucher number differs.
  const payload = {
    buildingId,
    monthYear,
    category: category || null,
    description,
    amount,
    status,
    paidAmount: paidNow,
    payments:
      paidNow > 0 ? [{ amount: paidNow, monthYear, at: txnDate.date }] : [],
    paidAt: paidNow > 0 ? txnDate.date : null,
    recordedBy: actor.id,
  };

  // Writes under the period lock serialise, but a voucher can still clash
  // with an insert made outside it; retry with a freshly computed voucher.
  const MAX_VOUCHER_ATTEMPTS = 5;
  let expense;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await withOpenPeriod(buildingId, monthYear, async (session) => {
        const [doc] = await Expense.create(
          [{ ...payload, voucherNo: await nextVoucher(session) }],
          { session },
        );
        return doc;
      });
      if (res.error !== null) return fail(res.error);
      expense = res.value;
      break;
    } catch (err) {
      if (isDuplicateKey(err) && attempt < MAX_VOUCHER_ATTEMPTS) continue;
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

  const res = await withOpenPeriod(buildingId, monthYear, async (session) => {
    const [doc] = await Withdrawal.create(
      [
        {
          buildingId,
          monthYear,
          takenBy,
          amount,
          note: note || null,
          takenAt: txnDate.date,
          recordedBy: actor.id,
        },
      ],
      { session },
    );
    return doc;
  });
  if (res.error !== null) return fail(res.error);
  const wd = res.value;

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

  const res = await withOpenPeriod(buildingId, monthYear, async (session) => {
    const [doc] = await Charge.create(
      [
        {
          buildingId,
          tenancyId,
          userId: tenancy.userId,
          monthYear,
          category,
          description,
          amount,
          paidAmount: 0,
          status: CHARGE_STATUS.DUE,
        },
      ],
      { session },
    );
    return doc;
  });
  if (res.error !== null) return fail(res.error);
  const charge = res.value;

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
  const belowPaid = (paid: number) =>
    `Amount can't be below the ${showMoney(paid)} already paid.`;
  if (amount < charge.paidAmount) return fail(belowPaid(charge.paidAmount));

  // One conditional atomic update: it only applies while the new amount still
  // covers what's paid, so a payment landing meanwhile can't be undercut.
  const res = await withOpenPeriod(buildingId, monthYear, async (session) => {
    const old = await Charge.findOneAndUpdate(
      {
        _id: chargeId,
        buildingId,
        category: { $ne: CHARGE_CATEGORY.SERVICE_CHARGE },
        $expr: { $lte: [{ $ifNull: ["$paidAmount", 0] }, amount] },
      },
      [
        {
          $set: {
            // Log the edit against the open month so past months keep their
            // old values.
            adjustments: {
              $concatArrays: [
                { $ifNull: ["$adjustments", []] },
                [
                  {
                    monthYear: { $literal: monthYear },
                    amount: { $literal: amount },
                    description: { $literal: description },
                    prevAmount: "$amount",
                    prevDescription: "$description",
                    by: { $literal: actor.name ?? null },
                    at: { $literal: new Date() },
                  },
                ],
              ],
            },
            description: { $literal: description },
            amount: { $literal: amount },
          },
        },
        chargeStatusStage,
      ],
      { returnDocument: "before", updatePipeline: true, session },
    ).lean();
    if (!old) {
      const current = await Charge.findOne({ _id: chargeId, buildingId })
        .select("paidAmount")
        .session(session)
        .lean();
      throw new ActionAbort(
        current ? belowPaid(current.paidAmount ?? 0) : "Due not found.",
      );
    }
    return { description: old.description, amount: old.amount };
  });
  if (res.error !== null) return fail(res.error);
  const before = res.value;

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
  // Delete only while nothing is paid against it (re-checked atomically).
  const res = await withOpenPeriod(buildingId, monthYear, (session) =>
    Charge.deleteOne(
      { _id: chargeId, buildingId, paidAmount: { $not: { $gt: 0 } } },
      { session },
    ),
  );
  if (res.error !== null || res.value.deletedCount === 0) return;

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

  const res = await withOpenPeriod(buildingId, monthYear, (session) =>
    Income.findOneAndDelete({ _id: id, buildingId, monthYear }, { session }),
  );
  if (res.error !== null || !res.value) return;
  const income = res.value;

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

  // Deleting removes the row and its embedded payments; block it when a payment
  // was logged in another (possibly closed) month so that month isn't altered.
  const res = await withOpenPeriod(buildingId, monthYear, (session) =>
    Expense.findOneAndDelete(
      {
        _id: id,
        buildingId,
        monthYear,
        payments: { $not: { $elemMatch: { monthYear: { $ne: monthYear } } } },
      },
      { session },
    ),
  );
  if (res.error !== null || !res.value) return;
  const expense = res.value;

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

  // One atomic conditional update: paidAmount, the payments log, status and
  // paidAt change together, and only if this payment doesn't overpay — so
  // concurrent payments can't both pass the outstanding check.
  const paidExpr = { $ifNull: ["$paidAmount", 0] };
  const fullyPaidExpr = {
    $gte: [{ $add: ["$paidAmount", MONEY_EPSILON] }, "$amount"],
  };
  const res = await withOpenPeriod(buildingId, monthYear, async (session) => {
    const updated = await Expense.findOneAndUpdate(
      {
        _id: id,
        buildingId,
        $expr: {
          $and: [
            { $gt: [{ $subtract: ["$amount", paidExpr] }, 0] },
            {
              $lte: [
                { $add: [paidExpr, amount] },
                { $add: ["$amount", MONEY_EPSILON] },
              ],
            },
          ],
        },
      },
      [
        {
          $set: {
            paidAmount: { $add: [paidExpr, amount] },
            payments: {
              $concatArrays: [
                { $ifNull: ["$payments", []] },
                { $literal: [{ amount, monthYear, at: txnDate.date }] },
              ],
            },
          },
        },
        {
          $set: {
            status: {
              $cond: [
                fullyPaidExpr,
                EXPENSE_STATUS.PAID,
                EXPENSE_STATUS.PARTIAL,
              ],
            },
            paidAt: { $cond: [fullyPaidExpr, txnDate.date, "$paidAt"] },
          },
        },
      ],
      { returnDocument: "after", updatePipeline: true, session },
    );
    if (updated) return updated;

    const current = await Expense.findOne({ _id: id, buildingId })
      .select("amount paidAmount")
      .session(session)
      .lean();
    if (!current) throw new ActionAbort("Expense not found.");
    const outstanding = current.amount - (current.paidAmount ?? 0);
    if (outstanding <= 0) {
      throw new ActionAbort("This expense is already fully paid.");
    }
    throw new ActionAbort(`Amount exceeds the outstanding ${outstanding} to pay.`);
  });
  if (res.error !== null) return fail(res.error);
  const expense = res.value;

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

  // Atomic conditional update so concurrent returns can't over-repay; the
  // running total and the returns log change together.
  const returnedExpr = { $ifNull: ["$returnedAmount", 0] };
  const res = await withOpenPeriod(buildingId, monthYear, async (session) => {
    const updated = await Withdrawal.findOneAndUpdate(
      {
        _id: id,
        buildingId,
        $expr: {
          $lte: [
            { $add: [returnedExpr, amount] },
            { $add: ["$amount", MONEY_EPSILON] },
          ],
        },
      },
      [
        {
          $set: {
            returnedAmount: { $add: [returnedExpr, amount] },
            returns: {
              $concatArrays: [
                { $ifNull: ["$returns", []] },
                { $literal: [{ amount, monthYear, at: txnDate.date }] },
              ],
            },
          },
        },
      ],
      { returnDocument: "after", updatePipeline: true, session },
    );
    if (updated) return updated;

    const current = await Withdrawal.findOne({ _id: id, buildingId })
      .select("amount returnedAmount")
      .session(session)
      .lean();
    if (!current) throw new ActionAbort("Withdrawal not found.");
    const outstanding = current.amount - (current.returnedAmount ?? 0);
    throw new ActionAbort(
      `Amount exceeds the outstanding ${outstanding} to return.`,
    );
  });
  if (res.error !== null) return fail(res.error);
  const wd = res.value;

  const stillOwed = wd.amount - (wd.returnedAmount ?? 0);
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

  // Deleting removes the row and its embedded returns; block it when a return
  // was logged in another (possibly closed) month so that month isn't altered.
  const res = await withOpenPeriod(buildingId, monthYear, (session) =>
    Withdrawal.findOneAndDelete(
      {
        _id: id,
        buildingId,
        monthYear,
        returns: { $not: { $elemMatch: { monthYear: { $ne: monthYear } } } },
      },
      { session },
    ),
  );
  if (res.error !== null || !res.value) return;
  const wd = res.value;

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

  const seen = await Withdrawal.findOne({ _id: id, buildingId }, null, {
    lean: true,
  });
  if (!seen) return;
  const log: LogEntry[] = seen.returns ?? [];
  const last = log[log.length - 1];
  // Only undo a return that was recorded in the month being edited.
  if (!last || last.monthYear !== monthYear) return;
  const seenCount = log.filter(
    (r) =>
      r.amount === last.amount &&
      r.monthYear === last.monthYear &&
      (r.at?.getTime() ?? null) === (last.at?.getTime() ?? null),
  ).length;

  // Atomically remove exactly the entry the user saw (its last occurrence) and
  // its amount, in one update. The count guard makes a concurrent/double undo
  // of the same entry a no-op; returns added meanwhile are kept.
  const res = await withOpenPeriod(buildingId, monthYear, (session) =>
    Withdrawal.findOneAndUpdate(
      {
        _id: id,
        buildingId,
        $expr: { $eq: [countEntries("$returns", last), seenCount] },
      },
      [
        {
          $set: {
            returns: withoutLastEntry("$returns", last),
            returnedAmount: {
              $max: [
                0,
                {
                  $subtract: [
                    { $ifNull: ["$returnedAmount", 0] },
                    { $literal: last.amount },
                  ],
                },
              ],
            },
          },
        },
      ],
      { returnDocument: "after", updatePipeline: true, session },
    ),
  );
  if (res.error !== null || !res.value) return;
  const wd = res.value;

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

  const seen = await Expense.findOne({ _id: id, buildingId }, null, {
    lean: true,
  });
  if (!seen) return;
  const log: LogEntry[] = seen.payments ?? [];
  const last = log[log.length - 1];
  // Only undo a payment that was recorded in the month being edited.
  if (!last || last.monthYear !== monthYear) return;
  const seenCount = log.filter(
    (p) =>
      p.amount === last.amount &&
      p.monthYear === last.monthYear &&
      (p.at?.getTime() ?? null) === (last.at?.getTime() ?? null),
  ).length;

  // Atomically remove exactly the entry the user saw (its last occurrence),
  // subtract its amount and recompute status/paidAt, in one update. The count
  // guard makes a concurrent/double undo of the same entry a no-op; payments
  // added meanwhile are kept.
  const fullyPaid = {
    $gte: [{ $add: ["$paidAmount", MONEY_EPSILON] }, "$amount"],
  };
  const res = await withOpenPeriod(buildingId, monthYear, (session) =>
    Expense.findOneAndUpdate(
      {
        _id: id,
        buildingId,
        $expr: { $eq: [countEntries("$payments", last), seenCount] },
      },
      [
        {
          $set: {
            payments: withoutLastEntry("$payments", last),
            paidAmount: {
              $max: [
                0,
                {
                  $subtract: [
                    { $ifNull: ["$paidAmount", 0] },
                    { $literal: last.amount },
                  ],
                },
              ],
            },
          },
        },
        {
          $set: {
            status: {
              $cond: [
                { $lte: ["$paidAmount", 0] },
                EXPENSE_STATUS.DUE,
                {
                  $cond: [
                    fullyPaid,
                    EXPENSE_STATUS.PAID,
                    EXPENSE_STATUS.PARTIAL,
                  ],
                },
              ],
            },
            paidAt: { $cond: [fullyPaid, "$paidAt", null] },
          },
        },
      ],
      { returnDocument: "after", updatePipeline: true, session },
    ),
  );
  if (res.error !== null || !res.value) return;
  const expense = res.value;

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

  // Claim the payment by deleting it first: a second (double-submitted)
  // reverse finds nothing and does nothing. Each charge is then decremented
  // atomically, so payments recorded meanwhile are never overwritten.
  const res = await withOpenPeriod(buildingId, monthYear, async (session) => {
    const claimed = await Payment.findOneAndDelete(
      { _id: id, buildingId, monthYear },
      { session },
    );
    if (!claimed) return null;
    for (const alloc of claimed.allocations) {
      await undoChargePayment(alloc.chargeId, alloc.amount, session);
    }
    return claimed;
  });
  if (res.error !== null || !res.value) return;
  const payment = res.value;

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

  // Take the period lock first (same doc every ledger write touches), then
  // compute totals: writes in flight either committed before the lock or
  // conflict, retry, and find the month CLOSED.
  const closed = await inTransaction(async (session) => {
    const period = await MonthlyPeriod.findOneAndUpdate(
      { buildingId, monthYear, status: PERIOD_STATUS.OPEN },
      { $set: { updatedAt: new Date() } },
      { returnDocument: "after", session },
    );
    if (!period) return null;

    const totals = await getPeriodTotals(buildingId, monthYear);
    const closing = computeClosing(period.openingBalance, totals);

    // Tag unpaid service charges and DUE expenses as carried forward.
    await Charge.updateMany(
      {
        buildingId,
        monthYear,
        category: CHARGE_CATEGORY.SERVICE_CHARGE,
        status: { $ne: CHARGE_STATUS.PAID },
        carriedFrom: null,
      },
      { $set: { carriedFrom: monthYear } },
      { session },
    );
    await Expense.updateMany(
      { buildingId, monthYear, status: EXPENSE_STATUS.DUE, carriedFrom: null },
      { $set: { carriedFrom: monthYear } },
      { session },
    );

    await MonthlyPeriod.updateOne(
      { _id: period._id },
      {
        $set: {
          status: PERIOD_STATUS.CLOSED,
          closingBalance: closing,
          closedAt: new Date(),
          closedBy: actor.id,
        },
      },
      { session },
    );
    return { period, totals, closing };
  });
  if (!closed) return;
  const { period, totals, closing } = closed;

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

  // Touch the Building doc (like openMonth) so the single-open rule can't be
  // raced, then flip the period CLOSED -> OPEN in the same transaction.
  const period = await inTransaction(async (session) => {
    await Building.updateOne(
      { _id: buildingId },
      { $set: { updatedAt: new Date() } },
      { session },
    );
    const openElsewhere = await MonthlyPeriod.findOne({
      buildingId,
      status: PERIOD_STATUS.OPEN,
    })
      .session(session)
      .lean();
    if (openElsewhere) return null; // another month is open — locked

    return MonthlyPeriod.findOneAndUpdate(
      { buildingId, monthYear, status: PERIOD_STATUS.CLOSED },
      {
        $set: {
          status: PERIOD_STATUS.OPEN,
          closingBalance: null,
          closedAt: null,
          closedBy: null,
        },
      },
      { session },
    );
  });
  if (!period) return;

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

/** Why a month can't be deleted safely, or null when it can. */
async function deleteMonthBlocker(
  buildingId: string,
  monthYear: string,
): Promise<string | null> {
  const later = await MonthlyPeriod.exists({
    buildingId,
    monthYear: { $gt: monthYear },
  });
  if (later) {
    return "Only the latest month can be deleted; later months depend on its balance.";
  }

  const chargeIds = (
    await Charge.find({ buildingId, monthYear }).select("_id").lean()
  ).map((c) => c._id);
  if (chargeIds.length > 0) {
    const paidElsewhere = await Payment.exists({
      buildingId,
      monthYear: { $ne: monthYear },
      "allocations.chargeId": { $in: chargeIds },
    });
    if (paidElsewhere) {
      return "A payment booked in another month settles a due from this month. Reverse it first.";
    }
  }

  // This month's bills/advances settled in another month would lose that cash.
  const [expenseLoggedElsewhere, withdrawalLoggedElsewhere] = await Promise.all([
    Expense.exists({
      buildingId,
      monthYear,
      payments: { $elemMatch: { monthYear: { $ne: monthYear } } },
    }),
    Withdrawal.exists({
      buildingId,
      monthYear,
      returns: { $elemMatch: { monthYear: { $ne: monthYear } } },
    }),
  ]);
  if (expenseLoggedElsewhere) {
    return "An expense from this month was paid in another month. Undo that payment first.";
  }
  if (withdrawalLoggedElsewhere) {
    return "A withdrawal from this month was returned in another month. Undo that return first.";
  }

  // Earlier bills/advances settled during this month would keep a log entry
  // pointing at a month that no longer exists.
  const [expensePaidHere, withdrawalReturnedHere] = await Promise.all([
    Expense.exists({
      buildingId,
      monthYear: { $ne: monthYear },
      "payments.monthYear": monthYear,
    }),
    Withdrawal.exists({
      buildingId,
      monthYear: { $ne: monthYear },
      "returns.monthYear": monthYear,
    }),
  ]);
  if (expensePaidHere) {
    return "An earlier expense was paid during this month. Undo that payment first.";
  }
  if (withdrawalReturnedHere) {
    return "An earlier withdrawal was returned during this month. Undo that return first.";
  }

  return null;
}

/**
 * Delete a month entirely — its payments, income, expenses, withdrawals and
 * charges — then re-cascade the opening/closing balances of every later month.
 *
 * SuperAdmin only, and only for the building's latest month: deleting an
 * earlier month would silently rewrite the opening/closing balances of later
 * (possibly closed) months. It is also refused while any other month still
 * depends on this month's data, so nothing is left orphaned.
 *
 * Rendered through ConfirmActionForm, so every refusal (including a non-Super
 * Admin caller) comes back as `{ error }` and nothing is changed.
 */
export async function deleteMonth(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await superAdminOrNull();
  if (!actor) return fail("Only a Super Admin can delete a month.");

  const parsed = closeMonthSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
  });
  if (!parsed.success) return fail("Invalid month.");
  const { buildingId, monthYear } = parsed.data;

  await connectDB();
  if (!(await userManagesBuilding(buildingId))) {
    return fail("You do not manage this building.");
  }

  let period;
  try {
    period = await inTransaction(async (session) => {
      // Serialise with open/reopen (Building doc) and with every ledger write
      // into this month or the open month (their period docs).
      await Building.updateOne(
        { _id: buildingId },
        { $set: { updatedAt: new Date() } },
        { session },
      );
      await MonthlyPeriod.updateMany(
        { buildingId, $or: [{ monthYear }, { status: PERIOD_STATUS.OPEN }] },
        { $set: { updatedAt: new Date() } },
        { session },
      );
      const doomed = await MonthlyPeriod.findOne({ buildingId, monthYear })
        .session(session)
        .lean();
      if (!doomed) throw new ActionAbort("This month no longer exists.");

      const blocker = await deleteMonthBlocker(buildingId, monthYear);
      if (blocker) throw new ActionAbort(blocker);

      // Reverse this month's payments so charges from other months are
      // restored (atomic decrements, like reversePayment).
      const payments = await Payment.find({ buildingId, monthYear })
        .session(session)
        .lean();
      for (const p of payments) {
        for (const alloc of p.allocations) {
          await undoChargePayment(alloc.chargeId, alloc.amount, session);
        }
      }

      const scope = { buildingId, monthYear };
      await Payment.deleteMany(scope, { session });
      await Income.deleteMany(scope, { session });
      await Expense.deleteMany(scope, { session });
      await Withdrawal.deleteMany(scope, { session });
      await Charge.deleteMany(scope, { session });
      await MonthlyPeriod.deleteOne({ _id: doomed._id }, { session });
      return doomed;
    });
  } catch (err) {
    if (err instanceof ActionAbort) return fail(err.message);
    throw err;
  }

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
  return OK;
}
