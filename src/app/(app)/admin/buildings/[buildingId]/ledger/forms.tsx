"use client";

import { useActionState } from "react";
import {
  openMonth,
  recordPayment,
  addIncome,
  addExpense,
  addWithdrawal,
  type ActionState,
} from "./actions";

const initial: ActionState = { error: null };

const input =
  "h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50";
const label = "mb-1 block text-xs font-medium text-black/60 dark:text-white/60";
const btn =
  "inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60";

function Msg({ state }: { state: ActionState }) {
  if (state.error)
    return <span className="text-xs text-red-600 dark:text-red-400">{state.error}</span>;
  if (state.ok)
    return <span className="text-xs text-green-600 dark:text-green-400">Saved.</span>;
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
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
      <input type="hidden" name="buildingId" value={buildingId} />
      <div>
        <label className={label}>Month</label>
        <input type="month" name="monthYear" defaultValue={defaultMonth} required className={input} />
      </div>
      <div>
        <label className={label}>Service charge (per tenant)</label>
        <input type="number" name="serviceChargeAmount" min={0} defaultValue={3000} className={input} />
      </div>
      <div>
        <label className={label}>Opening balance (first month only)</label>
        <input type="number" name="openingBalance" min={0} defaultValue={0} className={input} />
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
    <form action={action} className="mt-1 flex items-center gap-2">
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
    <form action={action} className="flex flex-wrap items-end gap-2">
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
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="monthYear" value={monthYear} />
      <div className="min-w-40 flex-1">
        <label className={label}>Description</label>
        <input name="description" required placeholder="e.g. Electricity bill" className={input} />
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
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="monthYear" value={monthYear} />
      <div className="w-40">
        <label className={label}>Taken by</label>
        <input name="takenBy" required placeholder="e.g. Imran Bhai" className={input} />
      </div>
      <div className="w-28">
        <label className={label}>Amount</label>
        <input type="number" name="amount" min={1} className={input} />
      </div>
      <div className="min-w-32 flex-1">
        <label className={label}>Note</label>
        <input name="note" className={input} />
      </div>
      <button type="submit" disabled={pending} className={btn}>
        {pending ? "…" : "Add withdrawal"}
      </button>
      <div className="w-full">
        <Msg state={state} />
      </div>
    </form>
  );
}
