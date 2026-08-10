import { NextResponse } from "next/server";

import { requireSuperAdmin } from "@/lib/rbac";
import { exportBuilding } from "@/lib/building-transfer";
import { objectIdSchema } from "@/lib/validators/building";

type RouteContext = { params: Promise<{ buildingId: string }> };

export async function GET(_req: Request, context: RouteContext) {
  try {
    await requireSuperAdmin();
  } catch {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { buildingId } = await context.params;
  if (!objectIdSchema.safeParse(buildingId).success) {
    return new NextResponse("Not found", { status: 404 });
  }

  const data = await exportBuilding(buildingId);
  if (!data) return new NextResponse("Not found", { status: 404 });

  const rawName =
    typeof data.building.name === "string" ? data.building.name : "building";
  const safeName =
    rawName.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "building";
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${safeName}_${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
