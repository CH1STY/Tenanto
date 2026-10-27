// Server components: the month status strip and the "Who has paid" board.
// Pure presentation — all numbers are computed by the page and passed in.

const money = (n: number) => n.toLocaleString();

export type PayState = "PAID" | "PARTIAL" | "UNPAID" | "NONE";

export type BoardRow = {
  key: string;
  unit: string;
  name: string;
  isPastTenant: boolean;
  /** Sum of all charges (any category) dated this month. */
  due: number;
  /** Amount settled toward those charges. */
  paid: number;
  state: PayState;
  /** Unpaid balance on charges dated in other months. */
  arrears: number;
  /** Per-charge breakdown for this month (description, amount, paid). */
  breakdown: { id: string; description: string; amount: number; paid: number }[];
};

const STATE_META: Record<
  PayState,
  { label: string; pill: string; dot: string; accent: string }
> = {
  PAID: {
    label: "Paid",
    pill: "bg-green-500/15 text-green-700 dark:text-green-400",
    dot: "bg-green-500",
    accent: "border-l-green-500",
  },
  PARTIAL: {
    label: "Partial",
    pill: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
    accent: "border-l-amber-500",
  },
  UNPAID: {
    label: "Unpaid",
    pill: "bg-red-500/15 text-red-700 dark:text-red-400",
    dot: "bg-red-500",
    accent: "border-l-red-500",
  },
  NONE: {
    label: "Not charged",
    pill: "bg-black/5 text-black/60 dark:bg-white/10 dark:text-white/60",
    dot: "bg-black/30 dark:bg-white/40",
    accent: "border-l-black/15 dark:border-l-white/20",
  },
};

export function StatusPill({ state }: { state: PayState }) {
  const m = STATE_META[state];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.pill}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

export function MonthSummary(props: {
  monthName: string;
  isClosed: boolean;
  /** Set when the real current month isn't opened and we fell back. */
  fallbackNote: string | null;
  collected: number;
  billed: number;
  counts: Record<PayState, number>;
  totalOutstanding: number;
}) {
  const {
    monthName,
    isClosed,
    fallbackNote,
    collected,
    billed,
    counts,
    totalOutstanding,
  } = props;
  const pct = billed > 0 ? Math.round((collected / billed) * 100) : 0;
  const remaining = Math.max(0, billed - collected);

  return (
    <section
      aria-label={`${monthName} summary`}
      className="mt-6 rounded-xl border border-black/10 p-4 sm:p-5 dark:border-white/15 no-print"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">{monthName}</h2>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            isClosed
              ? "bg-black/5 text-black/60 dark:bg-white/10 dark:text-white/60"
              : "bg-blue-500/15 text-blue-700 dark:text-blue-400"
          }`}
        >
          {isClosed ? "Month closed" : "Month open"}
        </span>
      </div>
      {fallbackNote ? (
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          {fallbackNote}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm">
          Collected{" "}
          <span className="text-xl font-semibold tabular-nums">
            {money(collected)}
          </span>{" "}
          <span className="text-black/55 dark:text-white/55">
            of {money(billed)}
          </span>
        </p>
        <span className="text-sm font-semibold tabular-nums">
          {billed > 0 ? `${pct}%` : "—"}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Collected this month"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
      >
        <div
          className={`h-full rounded-full ${
            pct >= 100 ? "bg-green-500" : pct > 0 ? "bg-amber-500" : "bg-red-500"
          }`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-full bg-green-500" />
          <strong className="tabular-nums">{counts.PAID}</strong> paid
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-full bg-amber-500" />
          <strong className="tabular-nums">{counts.PARTIAL}</strong> partial
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-full bg-red-500" />
          <strong className="tabular-nums">{counts.UNPAID}</strong> unpaid
        </span>
        {counts.NONE > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-black/55 dark:text-white/55">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full bg-black/30 dark:bg-white/40"
            />
            <strong className="tabular-nums">{counts.NONE}</strong> not charged
          </span>
        ) : null}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-black/10 pt-4 text-sm dark:border-white/15">
        <div>
          <dt className="text-xs text-black/50 dark:text-white/50">
            Left this month
          </dt>
          <dd
            className={`mt-0.5 font-semibold tabular-nums ${
              remaining > 0 ? "text-red-600 dark:text-red-400" : ""
            }`}
          >
            {money(remaining)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-black/50 dark:text-white/50">
            Total outstanding (all months)
          </dt>
          <dd
            className={`mt-0.5 font-semibold tabular-nums ${
              totalOutstanding > 0 ? "text-red-600 dark:text-red-400" : ""
            }`}
          >
            {money(totalOutstanding)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function BoardTile({ r }: { r: BoardRow }) {
  const m = STATE_META[r.state];
  const left = Math.max(0, r.due - r.paid);
  return (
    <li
      className={`rounded-lg border border-l-4 border-black/10 px-4 py-3 dark:border-white/15 ${m.accent}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            <span className="font-semibold">{r.unit}</span> · {r.name}
            {r.isPastTenant ? (
              <span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-black/45 dark:text-white/45">
                (Past tenant)
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs tabular-nums text-black/55 dark:text-white/55">
            {r.state === "NONE"
              ? "Nothing charged this month"
              : `Paid ${money(r.paid)} of ${money(r.due)}`}
            {left > 0 && r.state !== "NONE" ? (
              <span className="ml-1 font-medium text-red-600 dark:text-red-400">
                · {money(left)} left
              </span>
            ) : null}
          </div>
        </div>
        <StatusPill state={r.state} />
      </div>
      {r.breakdown.length > 1 ? (
        <ul className="mt-2 space-y-0.5">
          {r.breakdown.map((b) => (
            <li
              key={b.id}
              className="flex justify-between gap-2 text-[11px] text-black/50 dark:text-white/50"
            >
              <span className="min-w-0 truncate">{b.description}</span>
              <span className="shrink-0 tabular-nums">
                {money(b.paid)} / {money(b.amount)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {r.arrears > 0 ? (
        <p className="mt-1.5 text-[11px] text-red-600/90 dark:text-red-400/90">
          + {money(r.arrears)} older / previous dues
        </p>
      ) : null}
    </li>
  );
}

function Group({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: BoardRow[];
  tone: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-4">
      <h3 className={`text-xs font-semibold uppercase tracking-wide ${tone}`}>
        {title} <span className="tabular-nums">({rows.length})</span>
      </h3>
      <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <BoardTile key={r.key} r={r} />
        ))}
      </ul>
    </div>
  );
}

export function WhoPaidBoard({
  monthName,
  rows,
}: {
  monthName: string;
  rows: BoardRow[];
}) {
  // Rows arrive sorted by unit; grouping keeps that order within each group.
  const notPaid = rows.filter((r) => r.state === "UNPAID");
  const partial = rows.filter((r) => r.state === "PARTIAL");
  const paid = rows.filter((r) => r.state === "PAID");
  const none = rows.filter((r) => r.state === "NONE");

  return (
    <section className="mt-8 no-print">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
        Who has paid — {monthName}
      </h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-black/55 dark:text-white/55">
          No active tenants.
        </p>
      ) : (
        <>
          <Group
            title="Not paid yet"
            rows={notPaid}
            tone="text-red-700 dark:text-red-400"
          />
          <Group
            title="Partly paid"
            rows={partial}
            tone="text-amber-700 dark:text-amber-400"
          />
          <Group
            title="Paid"
            rows={paid}
            tone="text-green-700 dark:text-green-400"
          />
          <Group
            title="Not charged"
            rows={none}
            tone="text-black/50 dark:text-white/50"
          />
        </>
      )}
    </section>
  );
}
