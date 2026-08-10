"use server";

import mongoose from "mongoose";
import { revalidatePath } from "next/cache";

import { connectDB } from "@/lib/db";
import {
  requireRole,
  requireSuperAdmin,
  userManagesBuilding,
} from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import {
  ROLES,
  AUDIT_ACTIONS,
  PERIOD_STATUS,
  CHARGE_CATEGORY,
  CHARGE_STATUS,
} from "@/lib/constants";
import { Unit } from "@/models/Unit";
import { User } from "@/models/User";
import { Tenancy } from "@/models/Tenancy";
import { Charge } from "@/models/Charge";
import { Payment } from "@/models/Payment";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import {
  tenantPlaceSchema,
  vacateSchema,
  tenantActiveSchema,
  manualChargeSchema,
  deleteChargeSchema,
} from "@/lib/validators/tenant";
import { payChargeSchema } from "@/lib/validators/ledger";
import { objectIdSchema } from "@/lib/validators/building";

export type ActionState = { error: string | null; ok?: boolean };
const OK: ActionState = { error: null, ok: true };
const fail = (error: string): ActionState => ({ error, ok: false });

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
}

/**
 * Assign a tenant to a unit. The tenant is either an existing one (picked by
 * id) or created fresh. If the unit is already occupied, the current tenancy is
 * closed first (reassignment) — old tenancies are kept for history. If the
 * chosen existing tenant already occupies another unit, that occupancy is ended
 * too (they move). Runs in a transaction so every change is atomic.
 */
export async function placeTenant(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let actor;
  try {
    actor = await requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER);
  } catch {
    return fail("Not authorized.");
  }

  const parsed = tenantPlaceSchema.safeParse({
    buildingId: formData.get("buildingId"),
    unitId: formData.get("unitId"),
    existingUserId: formData.get("existingUserId") ?? undefined,
    name: formData.get("name") ?? undefined,
    nid: formData.get("nid") ?? undefined,
    phone: formData.get("phone") ?? undefined,
    address: formData.get("address") ?? undefined,
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  }
  const { buildingId, unitId, existingUserId, name, nid, phone, address } =
    parsed.data;

  await connectDB();

  if (!(await userManagesBuilding(buildingId)))
    return fail("You do not manage this building.");

  const unit = await Unit.findOne({ _id: unitId, buildingId })
    .select("label")
    .lean();
  if (!unit) return fail("Unit not found in this building.");

  let existingTenant = null;
  if (existingUserId) {
    existingTenant = await User.findOne({
      _id: existingUserId,
      role: ROLES.TENANT,
    })
      .select("name")
      .lean();
    if (!existingTenant) return fail("Selected tenant not found.");
  }

  const session = await mongoose.startSession();
  let replacedUserName: string | null = null;
  let newUserId = "";
  let newTenancyId = "";
  let tenantName = existingTenant?.name ?? name ?? "";

  try {
    await session.withTransaction(async () => {
      // Close whatever tenancy currently holds the target unit (reassignment).
      const occupant = await Tenancy.findOne({
        unitId,
        isActive: true,
      }).session(session);
      if (occupant) {
        const prevUser = await User.findById(occupant.userId)
          .select("name")
          .session(session);
        replacedUserName = prevUser?.name ?? null;
        occupant.endDate = new Date();
        occupant.isActive = false;
        await occupant.save({ session });
      }

      let userId: mongoose.Types.ObjectId;

      if (existingUserId) {
        // Move the existing tenant: end any other active tenancy they hold.
        const currentlyElsewhere = await Tenancy.findOne({
          userId: existingUserId,
          isActive: true,
        }).session(session);
        if (currentlyElsewhere) {
          currentlyElsewhere.endDate = new Date();
          currentlyElsewhere.isActive = false;
          await currentlyElsewhere.save({ session });
        }
        // A returning tenant may have been deactivated — bring them back.
        const tenant = await User.findById(existingUserId).session(session);
        if (!tenant) throw new Error("Selected tenant not found.");
        if (!tenant.isActive) {
          tenant.isActive = true;
          await tenant.save({ session });
        }
        userId = tenant._id;
        tenantName = tenant.name;
      } else {
        const [user] = await User.create(
          [
            {
              name,
              // Omit NID/phone when blank so the partial unique index only
              // applies to real values (many tenants have neither).
              ...(nid ? { nid } : {}),
              phone: phone || null,
              address: address || null,
              role: ROLES.TENANT,
              isActive: true,
            },
          ],
          { session },
        );
        userId = user._id;
        tenantName = user.name;
      }

      const [tenancy] = await Tenancy.create(
        [{ buildingId, unitId, userId, isActive: true }],
        { session },
      );

      newUserId = String(userId);
      newTenancyId = String(tenancy._id);
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      return fail(`A tenant with NID "${nid}" already exists.`);
    }
    throw err;
  } finally {
    await session.endSession();
  }

  const actorInfo = { id: actor.id, name: actor.name, role: actor.role };

  if (replacedUserName) {
    await logAudit({
      action: AUDIT_ACTIONS.UPDATE,
      entity: "Tenancy",
      entityLabel: unit.label,
      buildingId,
      actor: actorInfo,
      description: `Ended tenancy of "${replacedUserName}" on unit ${unit.label} (reassignment).`,
    });
  }

  if (!existingUserId) {
    await logAudit({
      action: AUDIT_ACTIONS.CREATE,
      entity: "Tenant",
      entityId: newUserId,
      entityLabel: tenantName,
      buildingId,
      actor: actorInfo,
      description: `Added tenant "${tenantName}"${nid ? ` (NID ${nid})` : ""}.`,
      after: {
        name: tenantName,
        nid: nid || null,
        phone: phone || null,
        address: address || null,
      },
    });
  }

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "Tenancy",
    entityId: newTenancyId,
    entityLabel: unit.label,
    buildingId,
    actor: actorInfo,
    description: `Assigned "${tenantName}" to unit ${unit.label}${
      existingUserId ? " (existing tenant)" : ""
    }.`,
    after: { unit: unit.label, tenant: tenantName },
  });

  revalidatePath(`/admin/buildings/${buildingId}/tenants`);
  return OK;
}

/** End the active tenancy on a unit; the unit becomes vacant. */
export async function vacateUnit(formData: FormData) {
  const actor = await requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER);

  const parsed = vacateSchema.safeParse({ unitId: formData.get("unitId") });
  if (!parsed.success) return;
  const { unitId } = parsed.data;

  await connectDB();
  const tenancy = await Tenancy.findOne({ unitId, isActive: true });
  if (!tenancy) return;
  if (!(await userManagesBuilding(String(tenancy.buildingId)))) return;

  const [unit, tenant] = await Promise.all([
    Unit.findById(unitId).select("label").lean(),
    User.findById(tenancy.userId).select("name").lean(),
  ]);

  tenancy.endDate = new Date();
  tenancy.isActive = false;
  await tenancy.save();

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "Tenancy",
    entityId: String(tenancy._id),
    entityLabel: unit?.label ?? null,
    buildingId: String(tenancy.buildingId),
    actor: { id: actor.id, name: actor.name, role: actor.role },
    description: `Vacated unit ${unit?.label ?? ""} (tenant "${tenant?.name ?? ""}").`,
  });

  revalidatePath(`/admin/buildings/${tenancy.buildingId}/tenants`);
}

/**
 * Activate or deactivate a tenant record (SuperAdmin only). Deactivating also
 * ends the tenant's active tenancy, freeing their unit. The record and history
 * are preserved.
 */
export async function setTenantActive(formData: FormData) {
  const actor = await requireSuperAdmin();

  const parsed = tenantActiveSchema.safeParse({
    userId: formData.get("userId"),
    active: formData.get("active"),
  });
  if (!parsed.success) return;
  const { userId } = parsed.data;
  const active = parsed.data.active === "true";

  await connectDB();

  const ctxBuildingId = objectIdSchema.safeParse(formData.get("buildingId"));
  if (!active) {
    const hasOutstandingDue = await Charge.exists({
      userId,
      ...(ctxBuildingId.success ? { buildingId: ctxBuildingId.data } : {}),
      status: { $ne: CHARGE_STATUS.PAID },
    });
    if (hasOutstandingDue) return;
  }

  const tenant = await User.findOne({ _id: userId, role: ROLES.TENANT });
  if (!tenant) return;

  const before = tenant.isActive;
  tenant.isActive = active;
  await tenant.save();

  let vacatedLabel: string | null = null;
  let buildingId: string | null = null;

  if (!active) {
    const tenancy = await Tenancy.findOne({ userId, isActive: true });
    if (tenancy) {
      tenancy.endDate = new Date();
      tenancy.isActive = false;
      await tenancy.save();
      buildingId = String(tenancy.buildingId);
      const unit = await Unit.findById(tenancy.unitId).select("label").lean();
      vacatedLabel = unit?.label ?? null;
    }
  }

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "Tenant",
    entityId: userId,
    entityLabel: tenant.name,
    buildingId,
    actor: { id: actor.id, name: actor.name, role: actor.role },
    description: active
      ? `Reactivated tenant "${tenant.name}".`
      : `Deactivated tenant "${tenant.name}"${
          vacatedLabel ? ` and vacated unit ${vacatedLabel}` : ""
        }.`,
    before: { isActive: before },
    after: { isActive: active },
  });

  if (buildingId) revalidatePath(`/admin/buildings/${buildingId}/tenants`);
  // Best-effort refresh of the current building tenants page.
  if (ctxBuildingId.success) {
    revalidatePath(`/admin/buildings/${ctxBuildingId.data}/tenants`);
  }
}

/**
 * Add a manual due (previous balance, a bill, or anything else) for a tenant.
 * The charge is attached to the tenant's current tenancy (their latest one if
 * they aren't currently housed) so it stays part of their financial history.
 */
export async function addManualCharge(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let actor;
  try {
    actor = await requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER);
  } catch {
    return fail("Not authorized.");
  }

  const parsed = manualChargeSchema.safeParse({
    buildingId: formData.get("buildingId"),
    userId: formData.get("userId"),
    category: formData.get("category"),
    monthYear: formData.get("monthYear"),
    description: formData.get("description"),
    amount: formData.get("amount"),
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  }
  const { buildingId, userId, category, monthYear, description, amount } =
    parsed.data;

  await connectDB();

  if (!(await userManagesBuilding(buildingId)))
    return fail("You do not manage this building.");

  const tenant = await User.findOne({ _id: userId, role: ROLES.TENANT })
    .select("name")
    .lean();
  if (!tenant) return fail("Tenant not found.");

  // Prefer the active tenancy; fall back to the most recent one.
  const tenancy =
    (await Tenancy.findOne({ buildingId, userId, isActive: true }).lean()) ??
    (await Tenancy.findOne({ buildingId, userId })
      .sort({ createdAt: -1 })
      .lean());
  if (!tenancy) {
    return fail("Assign this tenant to a unit before adding dues.");
  }

  const charge = await Charge.create({
    buildingId,
    tenancyId: tenancy._id,
    userId,
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
    actor: { id: actor.id, name: actor.name, role: actor.role },
    description: `Added ${category} due "${description}" (${amount}) for "${tenant.name}".`,
    after: { category, monthYear, description, amount },
  });

  revalidatePath(`/admin/buildings/${buildingId}/tenants/${userId}`);
  return OK;
}

/**
 * Record a payment against one of a tenant's charges, from their profile. The
 * payment is booked in an OPEN month so it flows into that month's cash book.
 */
export async function payTenantCharge(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let actor;
  try {
    actor = await requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER);
  } catch {
    return fail("Not authorized.");
  }

  const parsed = payChargeSchema.safeParse({
    buildingId: formData.get("buildingId"),
    monthYear: formData.get("monthYear"),
    chargeId: formData.get("chargeId"),
    amount: formData.get("amount"),
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  }
  const { buildingId, monthYear, chargeId, amount } = parsed.data;

  await connectDB();

  if (!(await userManagesBuilding(buildingId)))
    return fail("You do not manage this building.");

  const period = await MonthlyPeriod.findOne({ buildingId, monthYear });
  if (!period) {
    return fail(
      `Month ${monthYear} is not open. Open it in the cash book first.`,
    );
  }
  if (period.status !== PERIOD_STATUS.OPEN) {
    return fail(`Month ${monthYear} is closed.`);
  }

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
    recordedBy: actor.id,
  });

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "Payment",
    entityId: String(payment._id),
    entityLabel: charge.description,
    buildingId,
    actor: { id: actor.id, name: actor.name, role: actor.role },
    description: `Received ${amount} toward "${charge.description}".`,
    after: { amount, charge: charge.description, category: charge.category },
  });

  revalidatePath(`/admin/buildings/${buildingId}/tenants/${charge.userId}`);
  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return OK;
}

/** Delete a manual due that hasn't been paid against (correction). */
export async function deleteCharge(formData: FormData) {
  const actor = await requireSuperAdmin();

  const parsed = deleteChargeSchema.safeParse({
    buildingId: formData.get("buildingId"),
    chargeId: formData.get("chargeId"),
  });
  if (!parsed.success) return;
  const { buildingId, chargeId } = parsed.data;

  await connectDB();
  const charge = await Charge.findOne({ _id: chargeId, buildingId });
  if (!charge) return;
  // Only manual dues with no payments can be removed.
  if (charge.category === CHARGE_CATEGORY.SERVICE_CHARGE) return;
  if (charge.paidAmount > 0) return;

  const userId = String(charge.userId);
  const label = charge.description;
  await charge.deleteOne();

  await logAudit({
    action: AUDIT_ACTIONS.DELETE,
    entity: "Charge",
    entityId: chargeId,
    entityLabel: label,
    buildingId,
    actor: { id: actor.id, name: actor.name, role: actor.role },
    description: `Deleted due "${label}".`,
  });

  revalidatePath(`/admin/buildings/${buildingId}/tenants/${userId}`);
}
