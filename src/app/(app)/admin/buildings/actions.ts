"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { connectDB } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/constants";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { Tenancy } from "@/models/Tenancy";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { Charge } from "@/models/Charge";
import { Payment } from "@/models/Payment";
import { Income } from "@/models/Income";
import { Expense } from "@/models/Expense";
import { Withdrawal } from "@/models/Withdrawal";
import { MonthMedia } from "@/models/MonthMedia";
import { importBuilding } from "@/lib/building-transfer";
import {
  buildingCreateSchema,
  buildingUpdateSchema,
  unitCreateSchema,
  unitUpdateSchema,
  objectIdSchema,
} from "@/lib/validators/building";

export type ActionState = { error: string | null; ok?: boolean };

const OK: ActionState = { error: null, ok: true };

function fail(message: string): ActionState {
  return { error: message, ok: false };
}

/** Build a list of unit docs from a comma-separated side label list. */
function generateUnits(
  buildingId: string,
  numberOfFloors: number,
  unitLabels: string | undefined,
  serviceChargeAmount: number,
) {
  const sides = (unitLabels ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const units: {
    buildingId: string;
    floorNumber: number;
    label: string;
    serviceChargeAmount: number;
  }[] = [];

  for (let floor = 1; floor <= numberOfFloors; floor++) {
    for (const side of sides) {
      units.push({
        buildingId,
        floorNumber: floor,
        label: `${side}${floor}`,
        serviceChargeAmount,
      });
    }
  }
  return units;
}

export async function createBuilding(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireSuperAdmin();
  } catch {
    return fail("Not authorized.");
  }

  const parsed = buildingCreateSchema.safeParse({
    name: formData.get("name"),
    address: formData.get("address"),
    numberOfFloors: formData.get("numberOfFloors"),
    unitLabels: formData.get("unitLabels"),
    serviceChargeAmount: formData.get("serviceChargeAmount"),
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  }

  const { name, address, numberOfFloors, unitLabels, serviceChargeAmount } =
    parsed.data;

  await connectDB();

  const building = await Building.create({
    name,
    address: address || null,
    numberOfFloors,
    createdBy: admin.id,
  });

  const units = generateUnits(
    String(building._id),
    numberOfFloors,
    unitLabels,
    serviceChargeAmount,
  );
  if (units.length > 0) {
    await Unit.insertMany(units);
  }

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "Building",
    entityId: String(building._id),
    entityLabel: building.name,
    buildingId: String(building._id),
    actor: { id: admin.id, name: admin.name, role: admin.role },
    description: `Created building with ${units.length} unit(s).`,
    after: {
      name,
      address: address || null,
      numberOfFloors,
      units: units.length,
    },
  });

  revalidatePath("/admin/buildings");
  redirect(`/admin/buildings/${building._id}`);
}

export async function updateBuilding(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireSuperAdmin();
  } catch {
    return fail("Not authorized.");
  }

  const parsed = buildingUpdateSchema.safeParse({
    buildingId: formData.get("buildingId"),
    name: formData.get("name"),
    address: formData.get("address"),
    numberOfFloors: formData.get("numberOfFloors"),
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  }

  const { buildingId, name, address, numberOfFloors } = parsed.data;

  await connectDB();
  const before = await Building.findById(buildingId).lean();
  if (!before) return fail("Building not found.");

  await Building.updateOne(
    { _id: buildingId },
    { $set: { name, address: address || null, numberOfFloors } },
  );

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "Building",
    entityId: buildingId,
    entityLabel: name,
    buildingId,
    actor: { id: admin.id, name: admin.name, role: admin.role },
    description: "Updated building details.",
    before: {
      name: before.name,
      address: before.address,
      numberOfFloors: before.numberOfFloors,
    },
    after: { name, address: address || null, numberOfFloors },
  });

  revalidatePath("/admin/buildings");
  revalidatePath(`/admin/buildings/${buildingId}`);
  return OK;
}

export async function importBuildingFromFile(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireSuperAdmin();
  } catch {
    return fail("Not authorized.");
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return fail("Choose a building export (.json) file.");
  }
  if (file.size > 30_000_000) {
    return fail("That file is too large (max 30 MB).");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return fail("That file is not valid JSON.");
  }

  const result = await importBuilding(parsed, admin.id);
  if (!result.ok) return fail(result.error);

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "Building",
    entityId: result.buildingId,
    entityLabel: result.name,
    buildingId: result.buildingId,
    actor: { id: admin.id, name: admin.name, role: admin.role },
    description: `Imported building "${result.name}" from a file.`,
  });

  revalidatePath("/admin/buildings");
  return OK;
}

export async function deleteBuilding(formData: FormData) {
  const admin = await requireSuperAdmin();

  const parsed = objectIdSchema.safeParse(formData.get("buildingId"));
  if (!parsed.success) redirect("/admin/buildings");
  const buildingId = parsed.data;

  await connectDB();
  const before = await Building.findById(buildingId).lean();
  if (!before) redirect("/admin/buildings");

  const { deletedCount } = await Unit.deleteMany({ buildingId });
  await Building.deleteOne({ _id: buildingId });

  // Remove every building-scoped record so nothing (including images) is orphaned.
  await Promise.all([
    Tenancy.deleteMany({ buildingId }),
    MonthlyPeriod.deleteMany({ buildingId }),
    Charge.deleteMany({ buildingId }),
    Payment.deleteMany({ buildingId }),
    Income.deleteMany({ buildingId }),
    Expense.deleteMany({ buildingId }),
    Withdrawal.deleteMany({ buildingId }),
    MonthMedia.deleteMany({ buildingId }),
  ]);

  await logAudit({
    action: AUDIT_ACTIONS.DELETE,
    entity: "Building",
    entityId: buildingId,
    entityLabel: before.name,
    buildingId,
    actor: { id: admin.id, name: admin.name, role: admin.role },
    description: `Deleted building and ${deletedCount} unit(s).`,
    before: {
      name: before.name,
      address: before.address,
      numberOfFloors: before.numberOfFloors,
      unitsRemoved: deletedCount,
    },
  });

  revalidatePath("/admin/buildings");
  redirect("/admin/buildings");
}

export async function createUnit(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireSuperAdmin();
  } catch {
    return fail("Not authorized.");
  }

  const parsed = unitCreateSchema.safeParse({
    buildingId: formData.get("buildingId"),
    floorNumber: formData.get("floorNumber"),
    label: formData.get("label"),
    serviceChargeAmount: formData.get("serviceChargeAmount"),
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  }

  const { buildingId, floorNumber, label, serviceChargeAmount } = parsed.data;

  await connectDB();
  const building = await Building.findById(buildingId).select("name").lean();
  if (!building) return fail("Building not found.");

  try {
    const unit = await Unit.create({
      buildingId,
      floorNumber,
      label,
      serviceChargeAmount,
    });

    await logAudit({
      action: AUDIT_ACTIONS.CREATE,
      entity: "Unit",
      entityId: String(unit._id),
      entityLabel: label,
      buildingId,
      actor: { id: admin.id, name: admin.name, role: admin.role },
      description: `Added unit "${label}" on floor ${floorNumber}.`,
      after: { label, floorNumber, serviceChargeAmount },
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      return fail(
        `A unit labelled "${label}" already exists in this building.`,
      );
    }
    throw err;
  }

  revalidatePath(`/admin/buildings/${buildingId}`);
  return OK;
}

export async function updateUnit(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireSuperAdmin();
  } catch {
    return fail("Not authorized.");
  }

  const parsed = unitUpdateSchema.safeParse({
    unitId: formData.get("unitId"),
    floorNumber: formData.get("floorNumber"),
    label: formData.get("label"),
    serviceChargeAmount: formData.get("serviceChargeAmount"),
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  }

  const { unitId, floorNumber, label, serviceChargeAmount } = parsed.data;

  await connectDB();
  const before = await Unit.findById(unitId).lean();
  if (!before) return fail("Unit not found.");

  try {
    await Unit.updateOne(
      { _id: unitId },
      { $set: { floorNumber, label, serviceChargeAmount } },
    );

    await logAudit({
      action: AUDIT_ACTIONS.UPDATE,
      entity: "Unit",
      entityId: unitId,
      entityLabel: label,
      buildingId: String(before.buildingId),
      actor: { id: admin.id, name: admin.name, role: admin.role },
      description: `Updated unit "${label}".`,
      before: {
        label: before.label,
        floorNumber: before.floorNumber,
        serviceChargeAmount: before.serviceChargeAmount,
      },
      after: { label, floorNumber, serviceChargeAmount },
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      return fail(
        `A unit labelled "${label}" already exists in this building.`,
      );
    }
    throw err;
  }

  revalidatePath(`/admin/buildings/${before.buildingId}`);
  return OK;
}

export async function deleteUnit(formData: FormData) {
  const admin = await requireSuperAdmin();

  const parsed = objectIdSchema.safeParse(formData.get("unitId"));
  if (!parsed.success) return;
  const unitId = parsed.data;

  await connectDB();
  const before = await Unit.findById(unitId).lean();
  if (!before) return;

  await Unit.deleteOne({ _id: unitId });

  await logAudit({
    action: AUDIT_ACTIONS.DELETE,
    entity: "Unit",
    entityId: unitId,
    entityLabel: before.label,
    buildingId: String(before.buildingId),
    actor: { id: admin.id, name: admin.name, role: admin.role },
    description: `Deleted unit "${before.label}".`,
    before: {
      label: before.label,
      floorNumber: before.floorNumber,
      serviceChargeAmount: before.serviceChargeAmount,
    },
  });

  revalidatePath(`/admin/buildings/${before.buildingId}`);
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
}
