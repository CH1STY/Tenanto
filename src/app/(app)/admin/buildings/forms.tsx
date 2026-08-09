"use client";

import { useActionState } from "react";
import {
  createBuilding,
  updateBuilding,
  createUnit,
  updateUnit,
  type ActionState,
} from "./actions";

const initial: ActionState = { error: null };

const inputCls =
  "h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50";
const labelCls =
  "mb-1 block text-xs font-medium text-black/60 dark:text-white/60";
const primaryBtn =
  "inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60";

function Message({ state }: { state: ActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return <p className="text-sm text-green-600 dark:text-green-400">Saved.</p>;
  }
  return null;
}

export function BuildingCreateForm() {
  const [state, action, pending] = useActionState(createBuilding, initial);

  return (
    <form action={action} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="name">
            Building name
          </label>
          <input id="name" name="name" required className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="address">
            Address
          </label>
          <input id="address" name="address" className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="numberOfFloors">
            Number of floors
          </label>
          <input
            id="numberOfFloors"
            name="numberOfFloors"
            type="number"
            min={1}
            defaultValue={1}
            required
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="serviceChargeAmount">
            Default service charge per unit
          </label>
          <input
            id="serviceChargeAmount"
            name="serviceChargeAmount"
            type="number"
            min={0}
            defaultValue={0}
            className={inputCls}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="unitLabels">
            Unit sides per floor (comma-separated, optional)
          </label>
          <input
            id="unitLabels"
            name="unitLabels"
            placeholder="e.g. A,B  → generates A1, B1, A2, B2 …"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-black/45 dark:text-white/45">
            Leave blank to add units manually later.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryBtn}>
          {pending ? "Creating…" : "Create building"}
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}

export function BuildingEditForm({
  building,
}: {
  building: {
    id: string;
    name: string;
    address: string | null;
    numberOfFloors: number;
  };
}) {
  const [state, action, pending] = useActionState(updateBuilding, initial);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="buildingId" value={building.id} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className={labelCls} htmlFor="edit-name">
            Building name
          </label>
          <input
            id="edit-name"
            name="name"
            defaultValue={building.name}
            required
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="edit-address">
            Address
          </label>
          <input
            id="edit-address"
            name="address"
            defaultValue={building.address ?? ""}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="edit-floors">
            Number of floors
          </label>
          <input
            id="edit-floors"
            name="numberOfFloors"
            type="number"
            min={1}
            defaultValue={building.numberOfFloors}
            required
            className={inputCls}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryBtn}>
          {pending ? "Saving…" : "Save changes"}
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}

export function UnitCreateForm({ buildingId }: { buildingId: string }) {
  const [state, action, pending] = useActionState(createUnit, initial);

  return (
    <form
      action={action}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-black/10 p-4 dark:border-white/15"
    >
      <input type="hidden" name="buildingId" value={buildingId} />
      <div className="w-20">
        <label className={labelCls} htmlFor="new-floor">
          Floor
        </label>
        <input
          id="new-floor"
          name="floorNumber"
          type="number"
          min={0}
          defaultValue={1}
          required
          className={inputCls}
        />
      </div>
      <div className="w-28">
        <label className={labelCls} htmlFor="new-label">
          Label
        </label>
        <input
          id="new-label"
          name="label"
          placeholder="e.g. A1"
          required
          className={inputCls}
        />
      </div>
      <div className="w-32">
        <label className={labelCls} htmlFor="new-service-charge">
          Service charge
        </label>
        <input
          id="new-service-charge"
          name="serviceChargeAmount"
          type="number"
          min={0}
          defaultValue={0}
          className={inputCls}
        />
      </div>
      <button type="submit" disabled={pending} className={primaryBtn}>
        {pending ? "Adding…" : "Add unit"}
      </button>
      <div className="w-full">
        <Message state={state} />
      </div>
    </form>
  );
}

export function UnitEditRow({
  unit,
}: {
  unit: {
    id: string;
    label: string;
    floorNumber: number;
    serviceChargeAmount: number;
  };
}) {
  const [state, action, pending] = useActionState(updateUnit, initial);

  return (
    <form
      action={action}
      className="flex flex-wrap items-end gap-2 rounded-md border border-black/10 p-3 dark:border-white/15"
    >
      <input type="hidden" name="unitId" value={unit.id} />
      <div className="w-16">
        <label className={labelCls}>Floor</label>
        <input
          name="floorNumber"
          type="number"
          min={0}
          defaultValue={unit.floorNumber}
          className={inputCls}
        />
      </div>
      <div className="w-24">
        <label className={labelCls}>Label</label>
        <input name="label" defaultValue={unit.label} className={inputCls} />
      </div>
      <div className="w-32">
        <label className={labelCls}>Service charge</label>
        <input
          name="serviceChargeAmount"
          type="number"
          min={0}
          defaultValue={unit.serviceChargeAmount}
          className={inputCls}
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-9 items-center justify-center rounded-md border border-black/15 px-3 text-sm font-medium hover:bg-black/4 dark:border-white/20 dark:hover:bg-white/10 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save"}
      </button>
      {state.error ? (
        <span className="w-full text-xs text-red-600 dark:text-red-400">
          {state.error}
        </span>
      ) : state.ok ? (
        <span className="w-full text-xs text-green-600 dark:text-green-400">
          Saved.
        </span>
      ) : null}
    </form>
  );
}
