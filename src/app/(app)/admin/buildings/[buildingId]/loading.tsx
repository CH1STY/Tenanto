const BLOCK = "animate-pulse rounded-md bg-black/5 dark:bg-white/10";

export default function BuildingAdminLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6 py-2">
      <span className="sr-only">Loading…</span>
      <div className={`${BLOCK} h-7 w-56`} aria-hidden />
      <div className="flex gap-2" aria-hidden>
        <div className={`${BLOCK} h-9 w-24`} />
        <div className={`${BLOCK} h-9 w-24`} />
        <div className={`${BLOCK} h-9 w-24`} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-hidden>
        <div className={`${BLOCK} h-24`} />
        <div className={`${BLOCK} h-24`} />
        <div className={`${BLOCK} h-24`} />
      </div>
      <div className={`${BLOCK} h-64 w-full`} aria-hidden />
    </div>
  );
}
