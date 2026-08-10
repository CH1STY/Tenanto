const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-08" -> "August 2026". Falls back to the input if malformed. */
export function monthLabel(monthYear: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthYear);
  if (!m) return monthYear;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return monthYear;
  return `${MONTH_NAMES[month - 1]} ${m[1]}`;
}

/** Filename for a downloaded cash book, e.g. "Matrichaya_August_2026". */
export function cashbookFileName(
  buildingName: string,
  monthYear: string,
): string {
  const [monthName, year] = monthLabel(monthYear).split(" ");
  const safeName =
    buildingName
      .trim()
      .replace(/[^\w]+/g, "_")
      .replace(/^_+|_+$/g, "") || "CashBook";
  return `${safeName}_${monthName}_${year ?? ""}`.replace(/_+$/, "");
}

/** First and last instant of a YYYY-MM month, in UTC. */
export function monthRange(monthYear: string): { start: Date; end: Date } {
  const [y, m] = monthYear.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  // Day 0 of the next month is the last day of this month.
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return { start, end };
}

/** Current month as YYYY-MM (UTC). */
export function currentMonthYear(): string {
  return new Date().toISOString().slice(0, 7);
}

/** YYYY-MM-DD (UTC) of the first day of a month. */
export function firstDayOfMonth(monthYear: string): string {
  return `${monthYear}-01`;
}

/** YYYY-MM-DD (UTC) of the last day of a month. */
export function lastDayOfMonth(monthYear: string): string {
  return monthRange(monthYear).end.toISOString().slice(0, 10);
}

/** YYYY-MM-DD (UTC) for display of any date value. */
export function shortDate(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10);
}

export type TxnDateResult =
  | { ok: true; date: Date }
  | { ok: false; error: string };

/**
 * Resolve a transaction date bound to a month.
 * - An explicit "YYYY-MM-DD" must fall inside the month, otherwise it's rejected.
 * - With no explicit date: today if it's the current month, else the month's last day.
 */
export function resolveTransactionDate(
  monthYear: string,
  explicit?: string | null,
): TxnDateResult {
  const { start, end } = monthRange(monthYear);

  if (explicit) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicit)) {
      return { ok: false, error: "Invalid date." };
    }
    const d = new Date(`${explicit}T12:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid date." };
    if (d < start || d > end) {
      return {
        ok: false,
        error: `Transaction date must be within ${monthLabel(monthYear)}.`,
      };
    }
    return { ok: true, date: d };
  }

  if (monthYear === currentMonthYear()) return { ok: true, date: new Date() };
  return { ok: true, date: end };
}
