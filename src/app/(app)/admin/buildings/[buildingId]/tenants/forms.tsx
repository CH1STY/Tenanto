"use client";

import { useActionState, useState } from "react";
import { placeTenant, type ActionState } from "./actions";

const initial: ActionState = { error: null };

const inputCls =
  "h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50";
const labelCls =
  "mb-1 block text-xs font-medium text-black/60 dark:text-white/60";

export type AvailableTenant = {
  id: string;
  name: string;
  nid?: string | null;
};

export function AssignTenantForm({
  buildingId,
  unitId,
  mode,
  availableTenants = [],
  buildingAddress = null,
}: {
  buildingId: string;
  unitId: string;
  mode: "assign" | "reassign";
  availableTenants?: AvailableTenant[];
  buildingAddress?: string | null;
}) {
  const [state, action, pending] = useActionState(placeTenant, initial);
  const isReassign = mode === "reassign";
  const hasExisting = availableTenants.length > 0;
  const [tab, setTab] = useState<"existing" | "new">(
    hasExisting ? "existing" : "new",
  );
  const [address, setAddress] = useState("");
  const [useBuildingAddress, setUseBuildingAddress] = useState(false);

  const tabBtn = (active: boolean) =>
    `inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium ${
      active
        ? "bg-foreground text-background"
        : "border border-black/15 hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10"
    }`;

  return (
    <details className="mt-3 rounded-md border border-black/10 dark:border-white/15">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
        {isReassign ? "Reassign this unit" : "Assign a tenant"}
      </summary>
      <form
        action={action}
        className="space-y-3 border-t border-black/10 p-3 dark:border-white/15"
      >
        <input type="hidden" name="buildingId" value={buildingId} />
        <input type="hidden" name="unitId" value={unitId} />

        {hasExisting ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTab("existing")}
              className={tabBtn(tab === "existing")}
            >
              Existing tenant
            </button>
            <button
              type="button"
              onClick={() => setTab("new")}
              className={tabBtn(tab === "new")}
            >
              New tenant
            </button>
          </div>
        ) : null}

        {tab === "existing" && hasExisting ? (
          <div>
            <label className={labelCls}>Choose an existing tenant</label>
            <select name="existingUserId" required className={inputCls}>
              <option value="">Select a tenant…</option>
              {availableTenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.nid ? ` · NID ${t.nid}` : ""}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-black/50 dark:text-white/50">
              Tenants not currently occupying a unit. Assigning moves them here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Full name</label>
              <input name="name" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>National ID (NID) · optional</label>
              <input name="nid" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Phone · optional</label>
              <input name="phone" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Address · optional</label>
              <input
                name="address"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  if (useBuildingAddress) setUseBuildingAddress(false);
                }}
                readOnly={useBuildingAddress}
                className={`${inputCls} read-only:opacity-60`}
              />
            </div>
            {buildingAddress ? (
              <label className="flex items-center gap-2 text-xs text-black/60 sm:col-span-2 dark:text-white/60">
                <input
                  type="checkbox"
                  checked={useBuildingAddress}
                  onChange={(e) => {
                    setUseBuildingAddress(e.target.checked);
                    setAddress(e.target.checked ? buildingAddress : "");
                  }}
                />
                Use building address ({buildingAddress})
              </label>
            ) : null}
          </div>
        )}

        {isReassign ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            This ends the current tenant&apos;s occupancy (history is kept) and
            assigns the unit to the selected tenant.
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60"
          >
            {pending
              ? "Saving…"
              : isReassign
                ? "Reassign unit"
                : "Assign tenant"}
          </button>
          {state.error ? (
            <span className="text-sm text-red-600 dark:text-red-400">
              {state.error}
            </span>
          ) : state.ok ? (
            <span className="text-sm text-green-600 dark:text-green-400">
              Saved.
            </span>
          ) : null}
        </div>
      </form>
    </details>
  );
}
