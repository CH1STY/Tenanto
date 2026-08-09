import { cookies } from "next/headers";

export const ACTIVE_BUILDING_COOKIE = "activeBuildingId";

/**
 * The visitor's active building id, read from a persistent cookie.
 * Works for anonymous and logged-in users alike; it persists until they
 * pick a different building.
 */
export async function getActiveBuildingId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ACTIVE_BUILDING_COOKIE)?.value ?? null;
}
