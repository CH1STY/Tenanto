"use client";

import { useActionState } from "react";
import {
  openMonth,
  recordPayment,
  addIncome,
  addExpense,
  addWithdrawal,
  addCharge,
  editCharge,
  removeCharge,
  updateMonthNote,
  type ActionState,
} from "./actions";
import { firstDayOfMonth, lastDayOfMonth } from "@/lib/dates";

const initial: ActionState = { error: null };

const input =
  "h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50";
const label = "mb-1 block text-xs font-medium text-black/60 dark:text-white/60";
const btn =
  "inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60";

/** Optional transaction-date picker, constrained to the ledger month. */
function DateField({ monthYear }: { monthYear: string }) {
  return (
    <div className="w-40">
      <label className={label}>Date (optional)</label>
      <input
        type="date"
        name="date"
        min={firstDayOfMonth(monthYear)}
        max={lastDayOfMonth(monthYear)}
        className={input}
      />
    </div>
  );
}

function Msg({ state }: { state: ActionState }) {
  if (state.error)
    return (
      <span className="text-xs text-red-600 dark:text-red-400">
        {state.error}
      </span>
    );
  if (state.ok)
    return (
      <span className="text-xs text-green-600 dark:text-green-400">Saved.</span>
    );
  return null;
}

export function OpenMonthForm({
  buildingId,
  defaultMonth,
}: {
  buildingId: string;
  defaultMonth: string;
}) {
  const [state, action, pending] = useActionState(openMonth, initial);
  return (
    <form
      action={action}
      className="no-print grid grid-cols-1 gap-3 sm:grid-cols-4"
    >
      <input type="hidden" name="buildingId" value={buildingId} />
      <div>
        <label className={label}>Month</label>
        <input
          type="month"
          name="monthYear"
          defaultValue={defaultMonth}
          required
          className={input}
        />
      </div>
      <div>
        <label className={label}>Service charge (per tenant)</label>
        <input
          type="number"
          name="serviceChargeAmount"
          min={0}
          defaultValue={3000}
          className={input}
        />
      </div>
      <div>
        <label className={label}>Opening balance (first month only)</label>
        <input
          type="number"
          name="openingBalance"
          min={0}
          defaultValue={0}
          className={input}
        />
      </div>
      <div className="flex items-end gap-3">
        <button type="submit" disabled={pending} className={btn}>
          {pending ? "Opening…" : "Open month"}
        </button>
      </div>
      <div className="sm:col-span-4">
        <Msg state={state} />
      </div>
    </form>
  );
}

export function PayForm({
  buildingId,
  monthYear,
  chargeId,
  remaining,
}: {
  buildingId: string;
  monthYear: string;
  chargeId: string;
  remaining: number;
}) {
  const [state, action, pending] = useActionState(recordPayment, initial);
  return (
    <form action={action} className="no-print mt-1 flex items-center gap-2">
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="monthYear" value={monthYear} />
      <input type="hidden" name="chargeId" value={chargeId} />
      <input
        type="number"
        name="amount"
        min={1}
        max={remaining}
        defaultValue={remaining}
        className="h-8 w-24 rounded-md border border-black/15 bg-transparent px-2 text-xs dark:border-white/20"
      />
      <input
        type="date"
        name="date"
        min={firstDayOfMonth(monthYear)}
        max={lastDayOfMonth(monthYear)}
        title="Transaction date (optional)"
        className="h-8 w-32 rounded-md border border-black/15 bg-transparent px-2 text-xs dark:border-white/20"
      />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-8 items-center justify-center rounded-md bg-foreground px-3 text-xs font-medium text-background hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "…" : "Pay"}
      </button>
      <Msg state={state} />
    </form>
  );
}

export function IncomeForm({
  buildingId,
  monthYear,
}: {
  buildingId: string;
  monthYear: string;
}) {
  const [state, action, pending] = useActionState(addIncome, initial);
  return (
    <form action={action} className="no-print flex flex-wrap items-end gap-2">
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="monthYear" value={monthYear} />
      <div className="w-40">
        <label className={label}>Source</label>
        <select name="source" className={input} defaultValue="ROOFTOP_RENT">
          <option value="ROOFTOP_RENT">Rooftop rent</option>
          <option value="ROOFTOP_ELECTRICITY">Rooftop electricity</option>
          <option value="CHARITY">Charity</option>
          <option value="OTHER">Other</option>
        </select>
      </div>
      <div className="min-w-40 flex-1">
        <label className={label}>Description</label>
        <input name="description" required className={input} />
      </div>
      <div className="w-28">
        <label className={label}>Amount</label>
        <input type="number" name="amount" min={1} className={input} />
      </div>
      <DateField monthYear={monthYear} />
      <button type="submit" disabled={pending} className={btn}>
        {pending ? "…" : "Add income"}
      </button>
      <div className="w-full">
        <Msg state={state} />
      </div>
    </form>
  );
}

export function ExpenseForm({
  buildingId,
  monthYear,
}: {
  buildingId: string;
  monthYear: string;
}) {
  const [state, action, pending] = useActionState(addExpense, initial);
  return (
    <form action={action} className="no-print flex flex-wrap items-end gap-2">
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="monthYear" value={monthYear} />
      <div className="min-w-40 flex-1">
        <label className={label}>Description</label>
        <input
          name="description"
          required
          placeholder="e.g. Electricity bill"
          className={input}
        />
      </div>
      <div className="w-28">
        <label className={label}>Amount</label>
        <input type="number" name="amount" min={1} className={input} />
      </div>
      <div className="w-28">
        <label className={label}>Status</label>
        <select name="status" defaultValue="PAID" className={input}>
          <option value="PAID">Paid</option>
          <option value="DUE">Due</option>
        </select>
      </div>
      <DateField monthYear={monthYear} />
      <button type="submit" disabled={pending} className={btn}>
        {pending ? "…" : "Add expense"}
      </button>
      <div className="w-full">
        <Msg state={state} />
      </div>
    </form>
  );
}

export function WithdrawalForm({
  buildingId,
  monthYear,
}: {
  buildingId: string;
  monthYear: string;
}) {
  const [state, action, pending] = useActionState(addWithdrawal, initial);
  return (
    <form action={action} className="no-print flex flex-wrap items-end gap-2">
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="monthYear" value={monthYear} />
      <div className="w-40">
        <label className={label}>Taken by</label>
        <input
          name="takenBy"
          required
          placeholder="e.g. Imran Bhai"
          className={input}
        />
      </div>
      <div className="w-28">
        <label className={label}>Amount</label>
        <input type="number" name="amount" min={1} className={input} />
      </div>
      <div className="min-w-32 flex-1">
        <label className={label}>Note</label>
        <input name="note" className={input} />
      </div>
      <DateField monthYear={monthYear} />
      <button type="submit" disabled={pending} className={btn}>
        {pending ? "…" : "Add withdrawal"}
      </button>
      <div className="w-full">
        <Msg state={state} />
      </div>
    </form>
  );
}

export function AddChargeForm({
  buildingId,
  monthYear,
  tenants,
}: {
  buildingId: string;
  monthYear: string;
  tenants: { tenancyId: string; label: string }[];
}) {
  const [state, action, pending] = useActionState(addCharge, initial);
  return (
    <form action={action} className="no-print flex flex-wrap items-end gap-2">
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="monthYear" value={monthYear} />
      <div className="w-44">
        <label className={label}>Tenant</label>
        <select name="tenancyId" required className={input} defaultValue="">
          <option value="" disabled>
            Select tenant…
          </option>
          {tenants.map((t) => (
            <option key={t.tenancyId} value={t.tenancyId}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="w-36">
        <label className={label}>Type</label>
        <select name="category" defaultValue="BILL" className={input}>
          <option value="BILL">Bill</option>
          <option value="PREVIOUS_DUE">Previous due</option>
        </select>
      </div>
      <div className="min-w-40 flex-1">
        <label className={label}>Description</label>
        <input
          name="description"
          required
          placeholder="e.g. Water bill share"
          className={input}
        />
      </div>
      <div className="w-28">
        <label className={label}>Amount</label>
        <input type="number" name="amount" min={1} className={input} />
      </div>
      <button type="submit" disabled={pending} className={btn}>
        {pending ? "…" : "Add charge"}
      </button>
      <div className="w-full">
        <Msg state={state} />
      </div>
    </form>
  );
}

type DeleteAction = (formData: FormData) => void | Promise<void>;

export function EntryDeleteButton({
  action,
  buildingId,
  monthYear,
  id,
  message,
  title = "Delete",
}: {
  action: DeleteAction;
  buildingId: string;
  monthYear: string;
  id: string;
  message: string;
  title?: string;
}) {
  return (
    <form
      action={action}
      className="no-print inline"
      onSubmit={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="monthYear" value={monthYear} />
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        title={title}
        aria-label={title}
        className="ml-2 text-black/30 hover:text-red-600 dark:text-white/30 dark:hover:text-red-400"
      >
        ✕
      </button>
    </form>
  );
}

export function MonthNoteForm({
  buildingId,
  monthYear,
  note,
}: {
  buildingId: string;
  monthYear: string;
  note: string;
}) {
  const [state, action, pending] = useActionState(updateMonthNote, initial);
  return (
    <form action={action} className="no-print space-y-2">
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="monthYear" value={monthYear} />
      <textarea
        name="note"
        defaultValue={note}
        rows={3}
        placeholder="Add a note for this month (shown on next month's screen and print)…"
        className="w-full rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
      />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={btn}>
          {pending ? "…" : "Save note"}
        </button>
        <Msg state={state} />
      </div>
    </form>
  );
}

export function EditChargeForm({
  buildingId,
  monthYear,
  chargeId,
  description,
  amount,
  canDelete,
}: {
  buildingId: string;
  monthYear: string;
  chargeId: string;
  description: string;
  amount: number;
  canDelete: boolean;
}) {
  const [state, action, pending] = useActionState(editCharge, initial);
  const small =
    "h-7 rounded-md border border-black/15 bg-transparent px-2 text-[11px] outline-none focus:border-black/40 dark:border-white/20";
  return (
    <div className="no-print mt-1 space-y-1 border-t border-dashed border-black/10 pt-1 dark:border-white/15">
      <p className="text-[10px] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
        Adjust this month&apos;s due
      </p>
      <div className="flex flex-wrap items-center gap-1">
        <form action={action} className="flex flex-wrap items-center gap-1">
          <input type="hidden" name="buildingId" value={buildingId} />
          <input type="hidden" name="monthYear" value={monthYear} />
          <input type="hidden" name="chargeId" value={chargeId} />
          <input
            name="description"
            defaultValue={description}
            required
            className={`${small} w-32`}
          />
          <input
            type="number"
            name="amount"
            defaultValue={amount}
            min={1}
            className={`${small} w-24`}
          />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-7 items-center rounded-md border border-black/15 px-2 text-[11px] font-medium hover:bg-black/4 disabled:opacity-60 dark:border-white/20 dark:hover:bg-white/10"
          >
            {pending ? "…" : "Adjust"}
          </button>
        </form>
        {canDelete ? (
          <form
            action={removeCharge}
            onSubmit={(e) => {
              if (!window.confirm("Delete this due?")) e.preventDefault();
            }}
          >
            <input type="hidden" name="buildingId" value={buildingId} />
            <input type="hidden" name="monthYear" value={monthYear} />
            <input type="hidden" name="chargeId" value={chargeId} />
            <button
              type="submit"
              className="inline-flex h-7 items-center rounded-md border border-red-500/40 px-2 text-[11px] font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
            >
              Delete
            </button>
          </form>
        ) : null}
      </div>
      <Msg state={state} />
    </div>
  );
}

export function PrintButton({ fileName }: { fileName: string }) {
  // Set the document title so the browser's "Save as PDF" uses it as the filename.
  function download() {
    const prev = document.title;
    document.title = fileName;
    const restore = () => {
      document.title = prev;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }
  return (
    <button
      type="button"
      onClick={download}
      className="no-print inline-flex h-9 items-center justify-center rounded-md border border-black/15 px-4 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
    >
      Download
    </button>
  );
}
