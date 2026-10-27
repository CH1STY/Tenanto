import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, userManagesBuilding } from "@/lib/rbac";
import { ROLES } from "@/lib/constants";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { objectIdSchema } from "@/lib/validators/building";
import { BuildingTabs } from "./building-tabs";

/**
 * Shared header for every admin page of a building: breadcrumb, name and
 * section tabs, so Cash book / Tenants / Settings are one click apart.
 * Pages still run their own access checks.
 */
export default async function ManageBuildingLayout({
  children,
  params,
}: LayoutProps<"/admin/buildings/[buildingId]">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { buildingId } = await params;
  if (!objectIdSchema.safeParse(buildingId).success) notFound();
  if (!(await userManagesBuilding(buildingId, user))) redirect("/dashboard");
  const isSuperAdmin = user.role === ROLES.SUPER_ADMIN;

  await connectDB();
  const building = await Building.findById(buildingId)
    .select("name address")
    .lean();
  if (!building) notFound();

  return (
    <div className="space-y-8">
      <div className="no-print space-y-3">
        <nav
          aria-label="Breadcrumb"
          className="flex flex-wrap items-center gap-1.5 text-sm text-black/55 dark:text-white/55"
        >
          <Link
            href={isSuperAdmin ? "/admin/buildings" : "/dashboard"}
            className="hover:text-foreground"
          >
            {isSuperAdmin ? "Buildings" : "Dashboard"}
          </Link>
          <span aria-hidden>/</span>
          <span className="font-medium text-foreground">{building.name}</span>
        </nav>
        {building.address ? (
          <p className="text-xs text-black/50 dark:text-white/50">
            {building.address}
          </p>
        ) : null}
        <BuildingTabs buildingId={buildingId} showSettings={isSuperAdmin} />
      </div>
      {children}
    </div>
  );
}
