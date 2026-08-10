"use client";

import { Fragment, useState, useTransition } from "react";
import { monthLabel, currentMonthYear, cashbookFileName } from "@/lib/dates";
import { PERIOD_STATUS, EXPENSE_STATUS } from "@/lib/constants";
import { loadCashBook } from "./cashbook-actions";

export type CashRow = {
  key: string;
  label: string;
  paid: number;
  due: number;
  charges: {
    id: string;
    description: string;
    monthYear: string;
    fromOtherMonth: boolean;
    paidAmount: number;
    amount: number;
  }[];
};

export type CashBookData = {
  buildingName: string;
  monthYear: string;
  status: string;
  openingBalance: number;
  closingBalance: number | null;
  prevNote: string | null;
  prevNoteMonth: string | null;
  rows: CashRow[];
  incomes: {
    id: string;
    date: string;
    description: string;
    source: string;
    amount: number;
  }[];
  expenses: {
    id: string;
    date: string;
    voucherNo: number;
    description: string;
    status: string;
    amount: number;
  }[];
  withdrawals: {
    id: string;
    date: string;
    takenBy: string;
    note: string | null;
    amount: number;
  }[];
  totals: {
    payments: number;
    income: number;
    expensesPaid: number;
    withdrawals: number;
  };
};

const money = (n: number) => n.toLocaleString();

export function MonthlyCashBook({
  buildingId,
  periods,
  initialMonth,
  initialData,
}: {
  buildingId: string;
  periods: { monthYear: string; status: string }[];
  initialMonth: string;
  initialData: CashBookData | null;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<CashBookData | null>(initialData);
  const [pending, startTransition] = useTransition();

  function select(m: string) {
    if (m === month || pending) return;
    setMonth(m);
    // Keep the URL shareable without triggering a full server re-render.
    window.history.replaceState(null, "", `?month=${m}`);
    startTransition(async () => {
      const next = await loadCashBook(buildingId, m);
      setData(next);
    });
  }

  // Set the document title so the browser's "Save as PDF" uses it as the filename.
  function download() {
    if (!data) return;
    const prev = document.title;
    document.title = cashbookFileName(data.buildingName, data.monthYear);
    const restore = () => {
      document.title = prev;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }

  return (
    <>
      <div className="no-print">
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {periods.map((p) => {
            const active = p.monthYear === month;
            return (
              <button
                key={p.monthYear}
                type="button"
                onClick={() => select(p.monthYear)}
                aria-pressed={active}
                className={`inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm ${
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-black/15 hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
                }`}
              >
                {monthLabel(p.monthYear)}
                <span
                  className={`text-xs ${
                    p.status === PERIOD_STATUS.CLOSED
                      ? "opacity-70"
                      : active
                        ? ""
                        : "text-green-600 dark:text-green-400"
                  }`}
                >
                  {p.status === PERIOD_STATUS.CLOSED ? "closed" : "open"}
                </span>
              </button>
            );
          })}
          {data ? (
            <button
              type="button"
              onClick={download}
              className="ml-auto inline-flex h-8 items-center justify-center rounded-md border border-black/15 px-3 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
            >
              Download
            </button>
          ) : null}
        </div>

        {data ? (
          <div
            className={`mt-6 transition-opacity ${
              pending ? "pointer-events-none opacity-50" : ""
            }`}
          >
            <CashBookTables data={data} />
          </div>
        ) : (
          <p className="mt-6 text-sm text-black/55 dark:text-white/55">
            No data for this month.
          </p>
        )}
      </div>

      {data ? <PrintView data={data} /> : null}
    </>
  );
}

function CashBookTables({ data }: { data: CashBookData }) {
  const totalReceipts =
    data.openingBalance + data.totals.payments + data.totals.income;
  const cashInHand = totalReceipts - data.totals.expensesPaid;
  const closing = cashInHand - data.totals.withdrawals;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {data.prevNote ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 lg:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            Note from{" "}
            {data.prevNoteMonth
              ? monthLabel(data.prevNoteMonth)
              : "previous month"}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-black/70 dark:text-white/70">
            {data.prevNote}
          </p>
        </div>
      ) : null}
      {/* Receipts */}
      <div className="rounded-lg border border-black/10 dark:border-white/15">
        <header className="border-b border-black/10 px-4 py-3 text-sm font-semibold dark:border-white/15">
          Dr. — Receipts
        </header>
        <div className="divide-y divide-black/5 dark:divide-white/10">
          <Line
            label="Opening — cash in hand"
            amount={data.openingBalance}
            strong
          />

          {data.rows.map((r) => (
            <div key={r.key} className="px-4 py-3">
              <div className="text-sm font-medium">{r.label}</div>
              {r.charges.length === 0 ? (
                <p className="mt-1 text-xs text-black/45 dark:text-white/45">
                  No charges.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {r.charges.map((c) => {
                    const remaining = c.amount - c.paidAmount;
                    return (
                      <li key={c.id} className="text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-black/70 dark:text-white/70">
                            {c.description}
                            {c.fromOtherMonth ? (
                              <span className="ml-1 text-black/40 dark:text-white/40">
                                ({monthLabel(c.monthYear)})
                              </span>
                            ) : null}
                          </span>
                          {remaining > 0 ? (
                            <span className="shrink-0 tabular-nums font-medium text-red-600 dark:text-red-400">
                              Due {money(remaining)}
                            </span>
                          ) : (
                            <span className="shrink-0 text-green-600 dark:text-green-400">
                              Paid
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-black/45 dark:text-white/45">
                          Total {money(c.amount)}
                          {c.paidAmount > 0
                            ? ` · Paid ${money(c.paidAmount)}`
                            : ""}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}

          <div className="px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">
              Other income
            </p>
            {data.incomes.length === 0 ? (
              <p className="mt-1 text-xs text-black/45 dark:text-white/45">
                None.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {data.incomes.map((i) => (
                  <li
                    key={i.id}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-black/70 dark:text-white/70">
                      <span className="text-black/40 dark:text-white/40">
                        {i.date}
                      </span>{" "}
                      {i.description}{" "}
                      <span className="text-black/40 dark:text-white/40">
                        ({i.source})
                      </span>
                    </span>
                    <span className="tabular-nums">{money(i.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Line
            label="Total receipts (incl. opening)"
            amount={totalReceipts}
            strong
          />
        </div>
      </div>

      {/* Payments / Expenses */}
      <div className="rounded-lg border border-black/10 dark:border-white/15">
        <header className="border-b border-black/10 px-4 py-3 text-sm font-semibold dark:border-white/15">
          Cr. — Payments / Expenses
        </header>
        <div className="divide-y divide-black/5 dark:divide-white/10">
          <div className="px-4 py-3">
            {data.expenses.length === 0 ? (
              <p className="text-xs text-black/45 dark:text-white/45">
                No expenses.
              </p>
            ) : (
              <ul className="space-y-1">
                {data.expenses.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-black/70 dark:text-white/70">
                      <span className="text-black/40 dark:text-white/40">
                        {e.date}
                      </span>{" "}
                      <span className="text-black/40 dark:text-white/40">
                        V#{e.voucherNo}
                      </span>{" "}
                      {e.description}
                      {e.status === EXPENSE_STATUS.DUE ? (
                        <span className="ml-1 text-red-600 dark:text-red-400">
                          DUE
                        </span>
                      ) : null}
                    </span>
                    <span className="tabular-nums">{money(e.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Line
            label="Total expenses (paid)"
            amount={data.totals.expensesPaid}
            strong
          />
          <Line label="Cash in hand" amount={cashInHand} strong />

          <div className="px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">
              Withdrawals
            </p>
            {data.withdrawals.length === 0 ? (
              <p className="mt-1 text-xs text-black/45 dark:text-white/45">
                None.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {data.withdrawals.map((w) => (
                  <li
                    key={w.id}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-black/70 dark:text-white/70">
                      <span className="text-black/40 dark:text-white/40">
                        {w.date}
                      </span>{" "}
                      {w.takenBy}
                      {w.note ? (
                        <span className="text-black/40 dark:text-white/40">
                          {" "}
                          · {w.note}
                        </span>
                      ) : null}
                    </span>
                    <span className="tabular-nums">{money(w.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Line label="− Withdrawals" amount={data.totals.withdrawals} />
          <Line
            label={
              data.status === PERIOD_STATUS.CLOSED
                ? "Closing cash in hand (carried forward)"
                : "Closing cash in hand (projected)"
            }
            amount={data.closingBalance != null ? data.closingBalance : closing}
            strong
          />
        </div>
      </div>
    </div>
  );
}

function Line({
  label,
  amount,
  strong,
}: {
  label: string;
  amount: number;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span
        className={`text-sm ${
          strong ? "font-semibold" : "text-black/70 dark:text-white/70"
        }`}
      >
        {label}
      </span>
      <span className={`tabular-nums ${strong ? "font-semibold" : ""}`}>
        {money(amount)}
      </span>
    </div>
  );
}

/** Printable paper cash book (hidden on screen, shown only when printing). */
function PrintView({ data }: { data: CashBookData }) {
  const incomeTotal = data.incomes.reduce((s, i) => s + i.amount, 0);
  const tenantPaidTotal = data.rows.reduce((s, r) => s + r.paid, 0);
  const totalReceipts =
    data.openingBalance + data.totals.payments + data.totals.income;
  const cashInHand =
    totalReceipts - data.totals.expensesPaid - data.totals.withdrawals;
  const closing =
    data.status === PERIOD_STATUS.CLOSED && data.closingBalance != null
      ? data.closingBalance
      : cashInHand;
  const isCurrent = data.monthYear === currentMonthYear();
  const expenseDues = data.expenses.filter(
    (e) => e.status === EXPENSE_STATUS.DUE,
  );

  const cell = "border-b border-black/30 py-1";

  return (
    <div className="print-only text-black">
      <header className="text-center">
        <h1 className="text-xl font-bold">{data.buildingName}</h1>
        <p className="text-sm">Cash Book — {monthLabel(data.monthYear)}</p>
        <p className="mt-1 text-sm">
          Opening balance (cash in hand):{" "}
          <span className="font-semibold">{money(data.openingBalance)}</span>
        </p>
      </header>

      <div className="mt-4 grid grid-cols-2 gap-6">
        {/* Left — receipts */}
        <div>
          <h2 className="border-b-2 border-black pb-1 text-sm font-bold">
            Dr. — Receipts
          </h2>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left">
                <th className="py-1">Particulars</th>
                <th className="py-1 text-right">Paid</th>
                <th className="py-1 text-right">Due</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const dues = r.charges.filter(
                  (c) => c.amount - c.paidAmount > 0,
                );
                return (
                  <Fragment key={r.key}>
                    <tr>
                      <td className={cell}>{r.label}</td>
                      <td className={`${cell} text-right tabular-nums`}>
                        {money(r.paid)}
                      </td>
                      <td
                        className={`${cell} text-right tabular-nums ${
                          r.due > 0 ? "font-medium text-red-600" : ""
                        }`}
                      >
                        {r.due > 0 ? money(r.due) : "—"}
                      </td>
                    </tr>
                    {dues.map((c) => (
                      <tr key={c.id}>
                        <td className="py-0.5 pl-4 text-black/70">
                          ↳ {c.description} · {monthLabel(c.monthYear)}
                          <span className="text-black/50">
                            {" "}
                            (total {money(c.amount)}
                            {c.paidAmount > 0
                              ? `, paid ${money(c.paidAmount)}`
                              : ""}
                            )
                          </span>
                        </td>
                        <td />
                        <td className="py-0.5 text-right tabular-nums text-red-600">
                          {money(c.amount - c.paidAmount)}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
              {data.incomes.map((i) => (
                <tr key={i.id}>
                  <td className={cell}>
                    {i.description}{" "}
                    <span className="text-black/60">({i.source})</span>
                  </td>
                  <td className={`${cell} text-right tabular-nums`}>
                    {money(i.amount)}
                  </td>
                  <td className={cell} />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="py-1">Total receipts</td>
                <td className="py-1 text-right tabular-nums">
                  {money(tenantPaidTotal + incomeTotal)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Right — expenses */}
        <div>
          <h2 className="border-b-2 border-black pb-1 text-sm font-bold">
            Cr. — Payments / Expenses
          </h2>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left">
                <th className="py-1">Particulars</th>
                <th className="py-1 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.expenses.length === 0 ? (
                <tr>
                  <td className={cell} colSpan={2}>
                    No expenses.
                  </td>
                </tr>
              ) : (
                data.expenses.map((e) => (
                  <tr key={e.id}>
                    <td className={cell}>
                      <span className="text-black/60">V#{e.voucherNo}</span>{" "}
                      {e.description}
                      {e.status === EXPENSE_STATUS.DUE ? (
                        <span className="text-red-600"> (DUE)</span>
                      ) : (
                        ""
                      )}
                    </td>
                    <td className={`${cell} text-right tabular-nums`}>
                      {money(e.amount)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="py-1">Total expenses (paid)</td>
                <td className="py-1 text-right tabular-nums">
                  {money(data.totals.expensesPaid)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Notes & other dues */}
      <div className="mt-4">
        <h2 className="border-b border-black pb-1 text-sm font-bold">
          Notes &amp; outstanding dues
        </h2>
        {data.prevNote ? (
          <p className="mt-1 whitespace-pre-wrap text-xs">
            <span className="font-semibold">
              Note from{" "}
              {data.prevNoteMonth
                ? monthLabel(data.prevNoteMonth)
                : "previous month"}
              :
            </span>{" "}
            {data.prevNote}
          </p>
        ) : null}
        {expenseDues.length === 0 ? (
          <p className="mt-1 text-xs text-black/60">No outstanding payables.</p>
        ) : (
          <ul className="mt-1 text-xs">
            {expenseDues.map((e) => (
              <li
                key={e.id}
                className="flex justify-between border-b border-black/20 py-1"
              >
                <span>
                  V#{e.voucherNo} {e.description}
                </span>
                <span className="tabular-nums">{money(e.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer — cash in hand */}
      <div className="mt-4 border-t-2 border-black pt-2 text-sm">
        <div className="flex justify-between">
          <span>Total receipts (incl. opening)</span>
          <span className="tabular-nums">{money(totalReceipts)}</span>
        </div>
        <div className="flex justify-between">
          <span>Less total expenses (paid)</span>
          <span className="tabular-nums">
            {money(data.totals.expensesPaid)}
          </span>
        </div>
        {data.totals.withdrawals > 0 ? (
          <div className="flex justify-between">
            <span>Less withdrawals</span>
            <span className="tabular-nums">
              {money(data.totals.withdrawals)}
            </span>
          </div>
        ) : null}
        <div className="mt-1 flex justify-between border-t border-black pt-1 text-base font-bold">
          <span>
            {isCurrent
              ? "Current cash in hand"
              : `Cash in hand at end of ${monthLabel(data.monthYear)}`}
          </span>
          <span className="tabular-nums">{money(closing)}</span>
        </div>
      </div>
    </div>
  );
}
