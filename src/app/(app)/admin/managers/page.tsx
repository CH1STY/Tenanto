import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/rbac";
import { ROLES } from "@/lib/constants";
import { connectDB } from "@/lib/db";
import { User } from "@/models/User";
import { Building } from "@/models/Building";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { CreateManagerForm, ManagerBuildingsForm } from "./forms";
import { setManagerActive } from "./actions";

export default async function ManagersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== ROLES.SUPER_ADMIN) redirect("/dashboard");

  await connectDB();
  const [managers, buildings] = await Promise.all([
    User.find({ role: ROLES.MANAGER }).sort({ createdAt: -1 }).lean(),
    Building.find().sort({ name: 1 }).lean(),
  ]);

  const buildingOptions = buildings.map((b) => ({
    id: String(b._id),
    name: b.name,
  }));
  const buildingName = new Map(buildingOptions.map((b) => [b.id, b.name]));

  return (
    <div className="space-y-10">
      <div>
        <Link
          href="/dashboard"
          className="text-sm text-black/55 hover:text-foreground dark:text-white/55"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">Admins</h1>
        <p className="mt-1 text-sm text-black/55 dark:text-white/55">
          Create admins (managers), give them access to specific buildings, and
          deactivate them to block sign-in.
        </p>
      </div>

      <section className="rounded-lg border border-black/10 p-5 dark:border-white/15">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Add an admin
        </h2>
        <CreateManagerForm buildings={buildingOptions} />
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Admins ({managers.length})
        </h2>

        {managers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/15 p-10 text-center text-black/55 dark:border-white/20 dark:text-white/55">
            No admins yet. Add one above.
          </div>
        ) : (
          <div className="space-y-4">
            {managers.map((m) => {
              const assignedIds = (m.managedBuildingIds ?? []).map((id) =>
                String(id),
              );
              return (
                <div
                  key={String(m._id)}
                  className="rounded-lg border border-black/10 p-5 dark:border-white/15"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{m.name}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            m.isActive
                              ? "bg-green-500/15 text-green-700 dark:text-green-400"
                              : "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60"
                          }`}
                        >
                          {m.isActive ? "Active" : "Deactivated"}
                        </span>
                      </div>
                      <p className="mt-0.5 text-sm text-black/55 dark:text-white/55">
                        {m.email}
                      </p>
                      <p className="mt-1 text-xs text-black/50 dark:text-white/50">
                        {assignedIds.length === 0
                          ? "No buildings assigned"
                          : assignedIds
                              .map((id) => buildingName.get(id) ?? "Unknown")
                              .join(", ")}
                      </p>
                    </div>

                    <form action={setManagerActive}>
                      <input
                        type="hidden"
                        name="userId"
                        value={String(m._id)}
                      />
                      <input
                        type="hidden"
                        name="active"
                        value={m.isActive ? "false" : "true"}
                      />
                      <ConfirmSubmit
                        message={
                          m.isActive
                            ? `Deactivate ${m.name}? They will no longer be able to sign in.`
                            : `Reactivate ${m.name}? They will be able to sign in again.`
                        }
                        className={`inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm font-medium ${
                          m.isActive
                            ? "border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400"
                            : "border-black/15 hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
                        }`}
                      >
                        {m.isActive ? "Deactivate" : "Reactivate"}
                      </ConfirmSubmit>
                    </form>
                  </div>

                  {buildingOptions.length > 0 ? (
                    <ManagerBuildingsForm
                      userId={String(m._id)}
                      buildings={buildingOptions}
                      assignedIds={assignedIds}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
