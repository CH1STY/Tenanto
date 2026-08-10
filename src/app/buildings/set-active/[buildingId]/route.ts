import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { ACTIVE_BUILDING_COOKIE } from "@/lib/active-building";
import { objectIdSchema } from "@/lib/validators/building";

const ONE_YEAR = 60 * 60 * 24 * 365;

type RouteContext = {
  params: Promise<{ buildingId: string }>;
};

export async function GET(_req: Request, context: RouteContext) {
  const { buildingId } = await context.params;
  const parsed = objectIdSchema.safeParse(buildingId);
  if (!parsed.success) redirect("/buildings");

  await connectDB();
  const exists = await Building.exists({ _id: parsed.data });
  if (!exists) redirect("/buildings");

  const jar = await cookies();
  jar.set(ACTIVE_BUILDING_COOKIE, parsed.data, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR,
  });

  redirect(`/buildings/${parsed.data}`);
}
