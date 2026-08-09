"use client";

import { useActionState } from "react";
import { addManualCharge, payTenantCharge, type ActionState } from "../actions";

const initial: ActionState = { error: null };

const input =
  "h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50";
const label = "mb-1 block text-xs font-medium text-black/60 dark:text-white/60";
const btn =
  "inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60";

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

export function ManualChargeForm({
  buildingId,
  userId,
  defaultMonth,
}: {
  buildingId: string;
  userId: string;
  defaultMonth: string;
}) {
  const [state, action, pending] = useActionState(addManualCharge, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-5">
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="userId" value={userId} />
      <div>
        <label className={label}>Type</label>
        <select name="category" defaultValue="OTHER" className={input}>
          <option value="PREVIOUS_DUE">Previous due</option>
          <option value="BILL">Bill</option>
          <option value="OTHER">Other</option>
        </select>
      </div>
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
      <div className="sm:col-span-2">
        <label className={label}>Description</label>
        <input name="description" required className={input} />
      </div>
      <div>
        <label className={label}>Amount</label>
        <input type="number" name="amount" min={1} required className={input} />
      </div>
      <div className="flex items-center gap-3 sm:col-span-5">
        <button type="submit" disabled={pending} className={btn}>
          {pending ? "Adding…" : "Add due"}
        </button>
        <Msg state={state} />
      </div>
    </form>
  );
}

export function PayChargeForm({
  buildingId,
  chargeId,
  remaining,
  defaultMonth,
}: {
  buildingId: string;
  chargeId: string;
  remaining: number;
  defaultMonth: string;
}) {
  const [state, action, pending] = useActionState(payTenantCharge, initial);
  return (
    <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="buildingId" value={buildingId} />
      <input type="hidden" name="chargeId" value={chargeId} />
      <div>
        <label className={label}>Received in</label>
        <input
          type="month"
          name="monthYear"
          defaultValue={defaultMonth}
          required
          className="h-8 rounded-md border border-black/15 bg-transparent px-2 text-xs dark:border-white/20"
        />
      </div>
      <div>
        <label className={label}>Amount</label>
        <input
          type="number"
          name="amount"
          min={1}
          max={remaining}
          defaultValue={remaining}
          className="h-8 w-24 rounded-md border border-black/15 bg-transparent px-2 text-xs dark:border-white/20"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-8 items-center justify-center rounded-md bg-foreground px-3 text-xs font-medium text-background hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "…" : "Record payment"}
      </button>
      <Msg state={state} />
    </form>
  );
}
