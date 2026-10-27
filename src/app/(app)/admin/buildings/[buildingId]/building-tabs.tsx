"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { href: string; label: string; exact?: boolean };

/** Section tabs shared by every admin page of one building. */
export function BuildingTabs({
  buildingId,
  showSettings,
}: {
  buildingId: string;
  showSettings: boolean;
}) {
  const pathname = usePathname();
  const base = `/admin/buildings/${buildingId}`;

  const tabs: Tab[] = [
    { href: `${base}/ledger`, label: "Cash book" },
    { href: `${base}/tenants`, label: "Tenants" },
    ...(showSettings
      ? [{ href: base, label: "Units & settings", exact: true }]
      : []),
  ];

  return (
    <nav
      aria-label="Building sections"
      className="-mx-4 flex gap-1 overflow-x-auto border-b border-black/10 px-4 sm:mx-0 sm:px-0 dark:border-white/15"
    >
      {tabs.map((t) => {
        const active = t.exact
          ? pathname === t.href
          : pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "border-foreground text-foreground"
                : "border-transparent text-black/55 hover:text-foreground dark:text-white/55"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
      <Link
        href={`/buildings/${buildingId}`}
        className="-mb-px ml-auto shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-black/55 hover:text-foreground dark:text-white/55"
      >
        Public view ↗
      </Link>
    </nav>
  );
}
