import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/rbac";
import { ROLES, CHARGE_CATEGORY, CHARGE_STATUS } from "@/lib/constants";
import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { User } from "@/models/User";
import { Tenancy } from "@/models/Tenancy";
import { Charge } from "@/models/Charge";
import { Payment } from "@/models/Payment";
import { objectIdSchema } from "@/lib/validators/building";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { vacateUnit, setTenantActive, deleteCharge } from "../actions";
import { ManualChargeForm, PayChargeForm } from "./forms";

const money = (n: number) => n.toLocaleString();

const CATEGORY_LABEL: Record<string, string> = {
  SERVICE_CHARGE: "Service charge",
  PREVIOUS_DUE: "Previous due",
  BILL: "Bill",
  OTHER: "Other",
};

export default async function TenantProfilePage(props: {
  params: Promise<{ buildingId: string; tenantId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== ROLES.SUPER_ADMIN) redirect("/dashboard");

  const { buildingId, tenantId } = await props.params;
  if (
    !objectIdSchema.safeParse(buildingId).success ||
    !objectIdSchema.safeParse(tenantId).success
  ) {
    notFound();
  }

  await connectDB();
  const building = await Building.findById(buildingId).lean();
  if (!building) notFound();

  const tenant = await User.findOne({
    _id: tenantId,
    role: ROLES.TENANT,
  }).lean();
  if (!tenant) notFound();

  const [tenancies, charges, payments] = await Promise.all([
    Tenancy.find({ buildingId, userId: tenantId })
      .sort({ createdAt: -1 })
      .lean(),
    Charge.find({ buildingId, userId: tenantId })
      .sort({ monthYear: -1, createdAt: -1 })
      .lean(),
    Payment.find({ buildingId, userId: tenantId })
      .sort({ receivedAt: -1 })
      .lean(),
  ]);

  const unitIds = [...new Set(tenancies.map((t) => String(t.unitId)))];
  const units = await Unit.find({ _id: { $in: unitIds } })
    .select("label")
    .lean();
  const unitLabel = new Map(units.map((u) => [String(u._id), u.label]));

  const activeTenancy = tenancies.find((t) => t.isActive) ?? null;
  const currentUnit = activeTenancy
    ? unitLabel.get(String(activeTenancy.unitId))
    : null;

  const outstanding = charges.filter((c) => c.status !== CHARGE_STATUS.PAID);
  const totalDue = outstanding.reduce(
    (sum, c) => sum + (c.amount - c.paidAmount),
    0,
  );
  const totalBilled = charges.reduce((sum, c) => sum + c.amount, 0);
  const totalPaid = charges.reduce((sum, c) => sum + c.paidAmount, 0);

  const thisMonth = new Date().toISOString().slice(0, 7);

  return (
    <div className="space-y-10">
      <div>
        <Link
          href={`/admin/buildings/${buildingId}/tenants`}
          className="text-sm text-black/55 hover:text-foreground dark:text-white/55"
        >
          ← Back to tenants
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{tenant.name}</h1>
          {tenant.isActive ? (
            <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
              Active
            </span>
          ) : (
            <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs font-medium text-black/50 dark:bg-white/10 dark:text-white/50">
              Inactive
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-black/55 dark:text-white/55">
          {building.name}
          {currentUnit ? ` · Unit ${currentUnit}` : " · Not currently housed"}
        </p>
      </div>

      {/* Profile details + status actions */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-black/10 p-4 dark:border-white/15">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
            Details
          </h2>
          <dl className="space-y-1.5 text-sm">
            <Row label="NID" value={tenant.nid ?? "—"} />
            <Row label="Phone" value={tenant.phone ?? "—"} />
            <Row label="Address" value={tenant.address ?? "—"} />
            <Row
              label="Current unit"
              value={currentUnit ? `Unit ${currentUnit}` : "—"}
            />
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            {activeTenancy ? (
              <form action={vacateUnit}>
                <input
                  type="hidden"
                  name="unitId"
                  value={String(activeTenancy.unitId)}
                />
                <ConfirmSubmit
                  message={`Unassign ${tenant.name} from unit ${currentUnit}? This ends their occupancy (history is kept).`}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/15 px-3 text-xs font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
                >
                  Unassign from unit
                </ConfirmSubmit>
              </form>
            ) : null}
            <form action={setTenantActive}>
              <input type="hidden" name="userId" value={String(tenant._id)} />
              <input type="hidden" name="buildingId" value={buildingId} />
              <input
                type="hidden"
                name="active"
                value={tenant.isActive ? "false" : "true"}
              />
              {tenant.isActive ? (
                <ConfirmSubmit
                  message={`Deactivate ${tenant.name}? This also unassigns their unit if occupied.`}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-red-500/40 px-3 text-xs font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
                >
                  Deactivate
                </ConfirmSubmit>
              ) : (
                <button
                  type="submit"
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/15 px-3 text-xs font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
                >
                  Reactivate
                </button>
              )}
            </form>
          </div>
        </div>

        <div className="rounded-lg border border-black/10 p-4 dark:border-white/15">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
            Account summary
          </h2>
          <dl className="space-y-1.5 text-sm">
            <Row label="Total billed" value={money(totalBilled)} />
            <Row label="Total paid" value={money(totalPaid)} />
            <Row
              label="Outstanding due"
              value={money(totalDue)}
              strong
              danger={totalDue > 0}
            />
          </dl>
        </div>
      </section>

      {/* Tenancy history */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Tenancy history
        </h2>
        {tenancies.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">
            No tenancies recorded.
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {tenancies.map((t) => (
              <li
                key={String(t._id)}
                className="flex flex-wrap items-center gap-x-3 gap-y-1"
              >
                <span className="font-medium">
                  Unit {unitLabel.get(String(t.unitId)) ?? "—"}
                </span>
                <span className="text-black/55 dark:text-white/55">
                  {new Date(t.startDate).toLocaleDateString()} —{" "}
                  {t.endDate
                    ? new Date(t.endDate).toLocaleDateString()
                    : "present"}
                </span>
                {t.isActive ? (
                  <span className="text-xs text-green-600 dark:text-green-400">
                    active
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Add a manual due */}
      <section className="space-y-4 rounded-lg border border-black/10 p-5 dark:border-white/15">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Add a manual due
        </h2>
        {tenancies.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">
            Assign this tenant to a unit before adding dues.
          </p>
        ) : (
          <ManualChargeForm
            buildingId={buildingId}
            userId={String(tenant._id)}
            defaultMonth={thisMonth}
          />
        )}
      </section>

      {/* Dues / charges */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Dues &amp; charges ({charges.length})
        </h2>
        {charges.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/15 p-10 text-center text-black/55 dark:border-white/20 dark:text-white/55">
            No charges yet. Service charges are raised when a month is opened;
            add manual dues above.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-black/10 bg-black/2 text-xs uppercase tracking-wide text-black/50 dark:border-white/15 dark:bg-white/5 dark:text-white/50">
                <tr>
                  <th className="px-4 py-3 font-medium">Month</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Description</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Paid</th>
                  <th className="px-4 py-3 font-medium">Outstanding</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((c) => {
                  const id = String(c._id);
                  const remaining = c.amount - c.paidAmount;
                  const isManual =
                    c.category !== CHARGE_CATEGORY.SERVICE_CHARGE;
                  return (
                    <tr
                      key={id}
                      className="border-b border-black/5 align-top last:border-0 dark:border-white/10"
                    >
                      <td className="px-4 py-3 text-black/70 dark:text-white/70">
                        {c.monthYear}
                      </td>
                      <td className="px-4 py-3 text-black/70 dark:text-white/70">
                        {CATEGORY_LABEL[c.category] ?? c.category}
                      </td>
                      <td className="px-4 py-3">{c.description}</td>
                      <td className="px-4 py-3 text-black/70 dark:text-white/70">
                        {money(c.amount)}
                      </td>
                      <td className="px-4 py-3 text-black/70 dark:text-white/70">
                        {money(c.paidAmount)}
                      </td>
                      <td className="px-4 py-3">
                        {c.status === CHARGE_STATUS.PAID ? (
                          <span className="text-green-600 dark:text-green-400">
                            Paid
                          </span>
                        ) : (
                          <span className="font-medium text-red-600 dark:text-red-400">
                            {money(remaining)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {c.status !== CHARGE_STATUS.PAID ? (
                          <PayChargeForm
                            buildingId={buildingId}
                            chargeId={id}
                            remaining={remaining}
                            defaultMonth={thisMonth}
                          />
                        ) : null}
                        {isManual && c.paidAmount === 0 ? (
                          <form action={deleteCharge} className="mt-2">
                            <input
                              type="hidden"
                              name="buildingId"
                              value={buildingId}
                            />
                            <input type="hidden" name="chargeId" value={id} />
                            <ConfirmSubmit
                              message={`Delete due "${c.description}"?`}
                              className="inline-flex h-8 items-center justify-center rounded-md border border-red-500/40 px-3 text-xs font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
                            >
                              Delete
                            </ConfirmSubmit>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Payment history */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Payment history ({payments.length})
        </h2>
        {payments.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">
            No payments recorded.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-black/10 bg-black/2 text-xs uppercase tracking-wide text-black/50 dark:border-white/15 dark:bg-white/5 dark:text-white/50">
                <tr>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Booked in</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr
                    key={String(p._id)}
                    className="border-b border-black/5 last:border-0 dark:border-white/10"
                  >
                    <td className="px-4 py-3 text-black/70 dark:text-white/70">
                      {p.receivedAt
                        ? new Date(p.receivedAt).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-black/70 dark:text-white/70">
                      {p.monthYear}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {money(p.totalAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  danger,
}: {
  label: string;
  value: string;
  strong?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-black/55 dark:text-white/55">{label}</dt>
      <dd
        className={`${strong ? "font-semibold" : ""} ${
          danger ? "text-red-600 dark:text-red-400" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
