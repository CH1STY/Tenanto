import { auth } from "@/auth";
import { connectDB } from "@/lib/db";
import { User } from "@/models/User";
import { ROLES, type Role } from "@/lib/constants";

export type SessionUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role: Role;
};

/** Returns the signed-in user or null. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role as Role,
  };
}

/** Throws if not signed in. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("UNAUTHENTICATED");
  return user;
}

/** Throws unless the signed-in user has one of the allowed roles. */
export async function requireRole(...allowed: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!allowed.includes(user.role)) throw new Error("FORBIDDEN");
  return user;
}

/** Throws unless the signed-in user is a SuperAdmin. */
export async function requireSuperAdmin(): Promise<SessionUser> {
  return requireRole(ROLES.SUPER_ADMIN);
}

/**
 * True if the user may manage this building: SuperAdmins always, Managers only
 * for buildings they've been assigned. Pass `user` to avoid re-reading the session.
 */
export async function userManagesBuilding(
  buildingId: string,
  user?: SessionUser | null,
): Promise<boolean> {
  const u = user ?? (await getCurrentUser());
  if (!u) return false;
  if (u.role === ROLES.SUPER_ADMIN) return true;
  if (u.role !== ROLES.MANAGER) return false;

  await connectDB();
  const doc = await User.findById(u.id).select("managedBuildingIds").lean();
  const ids = (doc?.managedBuildingIds ?? []).map((id) => String(id));
  return ids.includes(buildingId);
}
