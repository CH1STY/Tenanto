"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { objectIdSchema } from "@/lib/validators/building";
import { ACTIVE_BUILDING_COOKIE } from "@/lib/active-building";
import { requirePublicAccess } from "@/lib/public-access";

const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Set the visitor's active building (persisted in a cookie) and open it.
 * Validates the id and confirms the building exists before storing anything.
 */
export async function setActiveBuilding(formData: FormData) {
  await requirePublicAccess();
  const parsed = objectIdSchema.safeParse(formData.get("buildingId"));
  if (!parsed.success) redirect("/buildings");

  const buildingId = parsed.data;

  await connectDB();
  const exists = await Building.exists({ _id: buildingId });
  if (!exists) redirect("/buildings");

  const jar = await cookies();
  jar.set(ACTIVE_BUILDING_COOKIE, buildingId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR,
  });

  redirect(`/buildings/${buildingId}`);
}
