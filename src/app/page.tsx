import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/rbac";
import { ThemeToggle } from "@/components/theme-toggle";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { getActiveBuildingId } from "@/lib/active-building";
import { objectIdSchema } from "@/lib/validators/building";

async function getActiveBuilding() {
  const id = await getActiveBuildingId();
  if (!id || !objectIdSchema.safeParse(id).success) return null;
  await connectDB();
  const b = await Building.findById(id).select("name").lean();
  return b ? { id, name: b.name } : null;
}

export default async function Home() {
  const [user, activeBuilding] = await Promise.all([
    getCurrentUser(),
    getActiveBuilding(),
  ]);

  // Home acts as an entrypoint: always open the visitor's active building.
  if (activeBuilding) redirect(`/buildings/${activeBuilding.id}`);

  await connectDB();
  const firstBuilding = await Building.findOne()
    .sort({ name: 1 })
    .select("_id")
    .lean();

  // First-time visitors get auto-assigned to the first building.
  if (firstBuilding?._id) {
    redirect(`/buildings/set-active/${String(firstBuilding._id)}`);
  }

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-2xl text-center">
        <span className="inline-flex items-center rounded-full border border-black/10 bg-black/3 px-3 py-1 text-xs font-medium tracking-wide text-black/60 dark:border-white/15 dark:bg-white/5 dark:text-white/60">
          Building Management
        </span>

        <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-5xl">
          Tenant App
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-base text-black/60 dark:text-white/60">
          Manage buildings, floors, units and tenants. Track month-wise service
          charges, payments, income, expenses and withdrawals — with a full,
          preserved history and a complete audit trail.
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/buildings"
            className="inline-flex h-11 items-center justify-center rounded-md bg-foreground px-6 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Browse buildings
          </Link>
          {user ? (
            <Link
              href="/dashboard"
              className="inline-flex h-11 items-center justify-center rounded-md border border-black/15 px-6 text-sm font-medium transition-colors hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
            >
              Go to dashboard
            </Link>
          ) : (
            <Link
              href="/login"
              className="inline-flex h-11 items-center justify-center rounded-md border border-black/15 px-6 text-sm font-medium transition-colors hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
            >
              Sign in
            </Link>
          )}
        </div>

        <dl className="mt-16 grid grid-cols-1 gap-6 text-left sm:grid-cols-3">
          <Feature
            title="Role-based access"
            body="SuperAdmin owns structure and identity; Managers run day-to-day finance."
          />
          <Feature
            title="Monthly cash book"
            body="Opening balance, charges, payments, expenses and closing cash in hand."
          />
          <Feature
            title="Full audit trail"
            body="Every create, edit and delete is logged and reviewable by the SuperAdmin."
          />
        </dl>
      </div>
    </main>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-black/10 p-5 dark:border-white/15">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-black/55 dark:text-white/55">{body}</p>
    </div>
  );
}
