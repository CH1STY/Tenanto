import { connectDB } from "@/lib/db";

// Only FAILED PIN entries are counted, so correct entries never use up the
// budget. Two fixed windows bound guessing: a short burst limit and an hourly
// cap. With 10 000 four-digit PINs the hourly cap alone makes an exhaustive
// search take ~100 hours (expected ~2 days); longer PINs make it impractical.
export const PIN_MINUTE_WINDOW_MS = 60_000;
export const PIN_MINUTE_MAX_FAILURES = 10;
export const PIN_HOUR_WINDOW_MS = 60 * 60_000;
export const PIN_HOUR_MAX_FAILURES = 100;

const SHARED_ID = "shared";

// New fields live beside the legacy `windowStart`/`attempts` fields of the same
// document, so instances still running the previous release keep working
// during a rolling deploy and nothing has to be migrated.
type PinAttemptDocument = {
  _id: string;
  failMinuteStart?: number;
  failMinuteCount?: number;
  failHourStart?: number;
  failHourCount?: number;
  failLocked?: boolean;
};

async function collection() {
  const mongoose = await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database is unavailable for PIN attempt limiting.");
  return db.collection<PinAttemptDocument>("public_pin_attempts");
}

/** Milliseconds until a new attempt is accepted; 0 when not locked out. */
export function pinRetryAfterMs(
  doc: PinAttemptDocument | null | undefined,
  now: number,
): number {
  if (!doc) return 0;
  let wait = 0;
  const minuteEnd = (doc.failMinuteStart ?? 0) + PIN_MINUTE_WINDOW_MS;
  if (minuteEnd > now && (doc.failMinuteCount ?? 0) >= PIN_MINUTE_MAX_FAILURES) {
    wait = Math.max(wait, minuteEnd - now);
  }
  const hourEnd = (doc.failHourStart ?? 0) + PIN_HOUR_WINDOW_MS;
  if (hourEnd > now && (doc.failHourCount ?? 0) >= PIN_HOUR_MAX_FAILURES) {
    wait = Math.max(wait, hourEnd - now);
  }
  return wait;
}

/**
 * Read-only lockout check, used before accepting a CORRECT PIN so a
 * brute-forcer cannot confirm a hit while the gate is locked.
 */
export async function publicPinRetryAfter(now = Date.now()): Promise<number> {
  const doc = await (await collection()).findOne({ _id: SHARED_ID });
  return pinRetryAfterMs(doc, now);
}

/**
 * Atomically records one failed PIN entry in the single shared document (no
 * trusted client IP needed, works across instances and restarts). Failures
 * made while already locked out are not counted, so hammering during a lockout
 * cannot extend it. Returns milliseconds to wait, or 0 if this failure was
 * within the allowed budget.
 */
export async function recordFailedPublicPinAttempt(
  now = Date.now(),
): Promise<number> {
  const minuteExpired = {
    $lte: [{ $ifNull: ["$failMinuteStart", 0] }, now - PIN_MINUTE_WINDOW_MS],
  };
  const hourExpired = {
    $lte: [{ $ifNull: ["$failHourStart", 0] }, now - PIN_HOUR_WINDOW_MS],
  };
  const result = await (await collection()).findOneAndUpdate(
    { _id: SHARED_ID },
    [
      {
        $set: {
          failMinuteStart: { $cond: [minuteExpired, now, "$failMinuteStart"] },
          failMinuteCount: {
            $cond: [minuteExpired, 0, { $ifNull: ["$failMinuteCount", 0] }],
          },
          failHourStart: { $cond: [hourExpired, now, "$failHourStart"] },
          failHourCount: {
            $cond: [hourExpired, 0, { $ifNull: ["$failHourCount", 0] }],
          },
        },
      },
      {
        $set: {
          failLocked: {
            $or: [
              { $gte: ["$failMinuteCount", PIN_MINUTE_MAX_FAILURES] },
              { $gte: ["$failHourCount", PIN_HOUR_MAX_FAILURES] },
            ],
          },
        },
      },
      {
        $set: {
          failMinuteCount: {
            $cond: ["$failLocked", "$failMinuteCount", { $add: ["$failMinuteCount", 1] }],
          },
          failHourCount: {
            $cond: ["$failLocked", "$failHourCount", { $add: ["$failHourCount", 1] }],
          },
        },
      },
    ],
    { upsert: true, returnDocument: "after" },
  );
  if (!result) throw new Error("PIN attempt counter could not be updated.");
  return result.failLocked ? Math.max(1, pinRetryAfterMs(result, now)) : 0;
}

export function pinLockoutMessage(waitMs: number): string {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return `Too many PIN attempts. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
