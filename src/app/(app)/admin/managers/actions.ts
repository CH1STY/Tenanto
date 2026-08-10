"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";

import { connectDB } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTIONS, LOGIN_ROLES, ROLES } from "@/lib/constants";
import { User } from "@/models/User";
import { Building } from "@/models/Building";
import {
  managerCreateSchema,
  managerActiveSchema,
  managerBuildingsSchema,
  managerPasswordSchema,
} from "@/lib/validators/manager";

export type ActionState = { error: string | null; ok?: boolean };
const OK: ActionState = { error: null, ok: true };
const fail = (error: string): ActionState => ({ error, ok: false });

async function actorOrNull() {
  try {
    return await requireSuperAdmin();
  } catch {
    return null;
  }
}

function actorInfo(a: { id: string; name?: string | null; role: string }) {
  return { id: a.id, name: a.name, role: a.role };
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
}

/** Keep only ids that refer to real buildings. */
async function validBuildingIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const found = await Building.find({ _id: { $in: ids } })
    .select("_id")
    .lean();
  return found.map((b) => String(b._id));
}

export async function createManager(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = managerCreateSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    buildingIds: formData.getAll("buildingIds"),
  });
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { name, email, password, buildingIds } = parsed.data;

  await connectDB();

  const managedBuildingIds = await validBuildingIds(buildingIds);
  const passwordHash = await bcrypt.hash(password, 10);

  let manager;
  try {
    manager = await User.create({
      name,
      email,
      passwordHash,
      role: ROLES.MANAGER,
      isActive: true,
      managedBuildingIds,
    });
  } catch (err) {
    if (isDuplicateKey(err))
      return fail("A user with that email already exists.");
    throw err;
  }

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "User",
    entityId: String(manager._id),
    entityLabel: name,
    actor: actorInfo(actor),
    description: `Added admin "${name}" (${email}) to ${managedBuildingIds.length} building(s).`,
    after: { email, role: ROLES.MANAGER, buildings: managedBuildingIds.length },
  });

  revalidatePath("/admin/managers");
  return OK;
}

export async function updateManagerBuildings(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = managerBuildingsSchema.safeParse({
    userId: formData.get("userId"),
    buildingIds: formData.getAll("buildingIds"),
  });
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { userId, buildingIds } = parsed.data;

  await connectDB();
  const manager = await User.findOne({ _id: userId, role: ROLES.MANAGER });
  if (!manager) return fail("Admin not found.");

  const managedBuildingIds = await validBuildingIds(buildingIds);
  manager.managedBuildingIds =
    managedBuildingIds as unknown as typeof manager.managedBuildingIds;
  await manager.save();

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "User",
    entityId: String(manager._id),
    entityLabel: manager.name,
    actor: actorInfo(actor),
    description: `Updated building access for "${manager.name}" (${managedBuildingIds.length} building(s)).`,
    after: { buildings: managedBuildingIds.length },
  });

  revalidatePath("/admin/managers");
  return OK;
}

export async function setManagerActive(formData: FormData) {
  const actor = await requireSuperAdmin();

  const parsed = managerActiveSchema.safeParse({
    userId: formData.get("userId"),
    active: formData.get("active"),
  });
  if (!parsed.success) return;
  const { userId, active } = parsed.data;

  await connectDB();
  const manager = await User.findOne({ _id: userId, role: ROLES.MANAGER });
  if (!manager) return;

  const isActive = active === "true";
  manager.isActive = isActive;
  await manager.save();

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "User",
    entityId: String(manager._id),
    entityLabel: manager.name,
    actor: actorInfo(actor),
    description: `${isActive ? "Reactivated" : "Deactivated"} admin "${manager.name}".`,
    after: { isActive },
  });

  revalidatePath("/admin/managers");
}

export async function updateAdminPassword(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await actorOrNull();
  if (!actor) return fail("Not authorized.");

  const parsed = managerPasswordSchema.safeParse({
    userId: formData.get("userId"),
    password: formData.get("password"),
  });
  if (!parsed.success)
    return fail(parsed.error.issues[0]?.message ?? "Invalid input.");

  const { userId, password } = parsed.data;

  await connectDB();
  const target = await User.findById(userId).select("name email role");
  if (!target || !LOGIN_ROLES.includes(target.role)) {
    return fail("Admin not found.");
  }

  target.passwordHash = await bcrypt.hash(password, 10);
  target.authVersion = (target.authVersion ?? 0) + 1;
  await target.save();

  const isSelf = String(target._id) === actor.id;
  const targetLabel = target.email
    ? `${target.name} (${target.email})`
    : target.name;

  await logAudit({
    action: AUDIT_ACTIONS.UPDATE,
    entity: "User",
    entityId: String(target._id),
    entityLabel: target.name,
    actor: actorInfo(actor),
    description: isSelf
      ? "Updated own password."
      : `Reset admin password for "${targetLabel}".`,
    after: { passwordReset: true },
  });

  revalidatePath("/admin/managers");
  return OK;
}
