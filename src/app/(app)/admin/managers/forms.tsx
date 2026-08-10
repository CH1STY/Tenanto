"use client";

import { useActionState } from "react";
import {
  createManager,
  updateManagerBuildings,
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
  if (state.error)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {state.error}
      </p>
    );
  if (state.ok)
    return <p className="text-sm text-green-600 dark:text-green-400">Saved.</p>;
  return null;
}

type BuildingOption = { id: string; name: string };

export function CreateManagerForm({
  buildings,
}: {
  buildings: BuildingOption[];
}) {
  const [state, action, pending] = useActionState(createManager, initial);

  return (
    <form action={action} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className={labelCls} htmlFor="name">
            Full name
          </label>
          <input id="name" name="name" required className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="email">
            Email (login)
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="password">
            Temporary password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            minLength={8}
            required
            className={inputCls}
          />
        </div>
      </div>

      <fieldset>
        <legend className={labelCls}>Buildings this admin can manage</legend>
        {buildings.length === 0 ? (
          <p className="text-sm text-black/55 dark:text-white/55">
            No buildings yet. Create a building first.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {buildings.map((b) => (
              <label
                key={b.id}
                className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm dark:border-white/15"
              >
                <input
                  type="checkbox"
                  name="buildingIds"
                  value={b.id}
                  className="h-4 w-4"
                />
                {b.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryBtn}>
          {pending ? "Adding…" : "Add admin"}
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}

export function ManagerBuildingsForm({
  userId,
  buildings,
  assignedIds,
}: {
  userId: string;
  buildings: BuildingOption[];
  assignedIds: string[];
}) {
  const [state, action, pending] = useActionState(
    updateManagerBuildings,
    initial,
  );
  const assigned = new Set(assignedIds);

  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="userId" value={userId} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {buildings.map((b) => (
          <label
            key={b.id}
            className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm dark:border-white/15"
          >
            <input
              type="checkbox"
              name="buildingIds"
              value={b.id}
              defaultChecked={assigned.has(b.id)}
              className="h-4 w-4"
            />
            {b.name}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-8 items-center justify-center rounded-md border border-black/15 px-3 text-sm font-medium hover:bg-black/4 disabled:opacity-60 dark:border-white/20 dark:hover:bg-white/10"
        >
          {pending ? "Saving…" : "Save building access"}
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}
