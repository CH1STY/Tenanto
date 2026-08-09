import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/rbac";
import { connectDB } from "@/lib/db";
import { AuditLog } from "@/models/AuditLog";
import { ROLES, AUDIT_ACTIONS } from "@/lib/constants";

const PAGE_SIZE = 50;

type SearchParams = {
  from?: string;
  to?: string;
  action?: string;
  entity?: string;
  page?: string;
};

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default async function AuditLogsPage(props: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== ROLES.SUPER_ADMIN) redirect("/dashboard");

  const sp = await props.searchParams;

  const from = parseDate(sp.from);
  const to = parseDate(sp.to);
  const actionFilter = sp.action && sp.action in AUDIT_ACTIONS ? sp.action : "";
  const entityFilter = (sp.entity ?? "").trim();
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const query: Record<string, unknown> = {};

  if (from || to) {
    const createdAt: Record<string, Date> = {};
    if (from) createdAt.$gte = from;
    if (to) {
      // Make the "to" date inclusive of the whole day.
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      createdAt.$lte = end;
    }
    query.createdAt = createdAt;
  }
  if (actionFilter) query.action = actionFilter;
  if (entityFilter) query.entity = entityFilter;

  await connectDB();

  const [rows, total] = await Promise.all([
    AuditLog.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean(),
    AuditLog.countDocuments(query),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Audit logs</h1>
          <p className="mt-1 text-sm text-black/55 dark:text-white/55">
            {total} record{total === 1 ? "" : "s"} — every create, edit and
            delete is recorded here.
          </p>
        </div>
      </div>

      <form
        method="get"
        className="mt-6 grid grid-cols-2 items-end gap-3 rounded-lg border border-black/10 p-4 dark:border-white/15 sm:flex sm:flex-wrap"
      >
        <Field label="From">
          <input
            type="date"
            name="from"
            defaultValue={sp.from ?? ""}
            className="h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm dark:border-white/20"
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            name="to"
            defaultValue={sp.to ?? ""}
            className="h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm dark:border-white/20"
          />
        </Field>
        <Field label="Action">
          <select
            name="action"
            defaultValue={actionFilter}
            className="h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm dark:border-white/20"
          >
            <option value="">All</option>
            <option value={AUDIT_ACTIONS.CREATE}>Create</option>
            <option value={AUDIT_ACTIONS.UPDATE}>Update</option>
            <option value={AUDIT_ACTIONS.DELETE}>Delete</option>
          </select>
        </Field>
        <Field label="Entity">
          <input
            type="text"
            name="entity"
            defaultValue={entityFilter}
            placeholder="e.g. User"
            className="h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm dark:border-white/20 sm:w-36"
          />
        </Field>

        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <button
            type="submit"
            className="inline-flex h-9 flex-1 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90 sm:flex-none"
          >
            Filter
          </button>
          <a
            href="/admin/audit-logs"
            className="inline-flex h-9 flex-1 items-center justify-center rounded-md border border-black/15 px-4 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10 sm:flex-none"
          >
            Reset
          </a>
        </div>
      </form>

      <div className="mt-6 overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-black/10 bg-black/2 text-xs uppercase tracking-wide text-black/50 dark:border-white/15 dark:bg-white/5 dark:text-white/50">
            <tr>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Entity</th>
              <th className="px-4 py-3 font-medium">Record</th>
              <th className="px-4 py-3 font-medium">Actor</th>
              <th className="px-4 py-3 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-10 text-center text-black/50 dark:text-white/50"
                >
                  No audit records match these filters.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={String(r._id)}
                  className="border-b border-black/5 last:border-0 dark:border-white/10"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-black/70 dark:text-white/70">
                    {new Date(r.createdAt as Date).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <ActionBadge action={String(r.action)} />
                  </td>
                  <td className="px-4 py-3">{r.entity}</td>
                  <td className="px-4 py-3 text-black/70 dark:text-white/70">
                    {r.entityLabel ?? (r.entityId ? String(r.entityId) : "—")}
                  </td>
                  <td className="px-4 py-3">
                    <span className="block">{r.actorName ?? "system"}</span>
                    <span className="block text-xs text-black/45 dark:text-white/45">
                      {r.actorRole ?? ""}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-black/70 dark:text-white/70">
                    {r.description ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <Pagination page={page} totalPages={totalPages} searchParams={sp} />
      ) : null}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex w-full flex-col gap-1 text-xs font-medium text-black/60 dark:text-white/60 sm:w-auto">
      {label}
      {children}
    </label>
  );
}

function ActionBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    CREATE: "bg-green-500/15 text-green-700 dark:text-green-400",
    UPDATE: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    DELETE: "bg-red-500/15 text-red-700 dark:text-red-400",
  };
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${
        styles[action] ?? "bg-black/10 dark:bg-white/10"
      }`}
    >
      {action}
    </span>
  );
}

function Pagination({
  page,
  totalPages,
  searchParams,
}: {
  page: number;
  totalPages: number;
  searchParams: SearchParams;
}) {
  const build = (p: number) => {
    const params = new URLSearchParams();
    if (searchParams.from) params.set("from", searchParams.from);
    if (searchParams.to) params.set("to", searchParams.to);
    if (searchParams.action) params.set("action", searchParams.action);
    if (searchParams.entity) params.set("entity", searchParams.entity);
    params.set("page", String(p));
    return `/admin/audit-logs?${params.toString()}`;
  };

  return (
    <div className="mt-4 flex items-center justify-between text-sm">
      <span className="text-black/55 dark:text-white/55">
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <a
            href={build(page - 1)}
            className="inline-flex h-9 items-center rounded-md border border-black/15 px-3 hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
          >
            Previous
          </a>
        ) : null}
        {page < totalPages ? (
          <a
            href={build(page + 1)}
            className="inline-flex h-9 items-center rounded-md border border-black/15 px-3 hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
          >
            Next
          </a>
        ) : null}
      </div>
    </div>
  );
}
