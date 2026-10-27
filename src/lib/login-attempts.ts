import { createHmac } from "node:crypto";
import { connectDB } from "@/lib/db";

// Per-account limit against password guessing, plus a global cap against
// credential spraying across many emails. Counters are reserved atomically
// BEFORE the password check, so concurrent requests can never exceed the
// limit; a successful login clears the account's counter and returns its
// global slot, so only failures count.
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_FAILURES_PER_EMAIL = 5;
export const LOGIN_MAX_FAILURES_GLOBAL = 100;

const COLLECTION = "login_attempts";
const GLOBAL_ID = "global";

type LoginAttemptDocument = {
  _id: string;
  windowStart: number;
  failures: number;
  locked: boolean;
  expiresAt: Date;
};

export type LoginReservation = {
  emailId: string;
  emailWindowStart: number;
  globalWindowStart: number;
};

export type LoginReserveResult =
  | { allowed: true; reservation: LoginReservation }
  | { allowed: false; retryAfterMs: number };

let indexReady: Promise<unknown> | null = null;

async function collection() {
  const mongoose = await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database is unavailable for login rate limiting.");
  const attempts = db.collection<LoginAttemptDocument>(COLLECTION);
  // TTL clean-up of expired windows on this collection only. createIndex is
  // idempotent; a failure here must never block sign-in, so it is retried on
  // the next call instead of being thrown.
  indexReady ??= attempts
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    .catch(() => {
      indexReady = null;
    });
  return attempts;
}

/** Stores a keyed hash of the normalised email, never the address itself. */
export function loginAttemptId(email: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for login limiting.");
  const digest = createHmac("sha256", secret)
    .update(`login-attempt:${email.trim().toLowerCase()}`)
    .digest("hex");
  return `email:${digest}`;
}

async function reserve(id: string, limit: number, now: number) {
  const expired = {
    $lte: [{ $ifNull: ["$windowStart", 0] }, now - LOGIN_WINDOW_MS],
  };
  const result = await (await collection()).findOneAndUpdate(
    { _id: id },
    [
      {
        $set: {
          windowStart: { $cond: [expired, now, "$windowStart"] },
          failures: { $cond: [expired, 0, { $ifNull: ["$failures", 0] }] },
        },
      },
      { $set: { locked: { $gte: ["$failures", limit] } } },
      {
        $set: {
          failures: {
            $cond: ["$locked", "$failures", { $add: ["$failures", 1] }],
          },
          expiresAt: { $toDate: { $add: ["$windowStart", LOGIN_WINDOW_MS] } },
        },
      },
    ],
    { upsert: true, returnDocument: "after" },
  );
  if (!result) throw new Error("Login attempt counter could not be updated.");
  return result;
}

async function refund(id: string, windowStart: number) {
  // Only give the slot back to the same window it was taken from.
  await (await collection()).updateOne(
    { _id: id, windowStart, failures: { $gt: 0 } },
    { $inc: { failures: -1 } },
  );
}

function retryAfter(doc: LoginAttemptDocument, now: number) {
  return Math.max(1, doc.windowStart + LOGIN_WINDOW_MS - now);
}

export async function reserveLoginAttempt(
  email: string,
  now = Date.now(),
): Promise<LoginReserveResult> {
  const emailId = loginAttemptId(email);
  const perEmail = await reserve(emailId, LOGIN_MAX_FAILURES_PER_EMAIL, now);
  if (perEmail.locked) {
    return { allowed: false, retryAfterMs: retryAfter(perEmail, now) };
  }
  const global = await reserve(GLOBAL_ID, LOGIN_MAX_FAILURES_GLOBAL, now);
  if (global.locked) {
    await refund(emailId, perEmail.windowStart);
    return { allowed: false, retryAfterMs: retryAfter(global, now) };
  }
  return {
    allowed: true,
    reservation: {
      emailId,
      emailWindowStart: perEmail.windowStart,
      globalWindowStart: global.windowStart,
    },
  };
}

/**
 * "failure": keep the reserved slots (a wrong password counts).
 * "success": clear this email's counter and return the global slot.
 * "error": the check never completed (e.g. outage), so return both slots.
 */
export async function settleLoginAttempt(
  reservation: LoginReservation,
  outcome: "success" | "failure" | "error",
): Promise<void> {
  if (outcome === "failure") return;
  const attempts = await collection();
  if (outcome === "success") {
    await attempts.deleteOne({ _id: reservation.emailId });
  } else {
    await refund(reservation.emailId, reservation.emailWindowStart);
  }
  await refund(GLOBAL_ID, reservation.globalWindowStart);
}

export function loginLockoutMessage(waitMs: number): string {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return `Too many attempts, try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
