import { connectDB } from "@/lib/db";

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 20;

export async function consumePublicPinAttempt(): Promise<boolean> {
  const mongoose = await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database is unavailable for PIN attempt limiting.");

  const now = Date.now();
  const expired = {
    $lte: [{ $ifNull: ["$windowStart", 0] }, now - WINDOW_MS],
  };
  // One atomic, persistent counter shared by all app instances; no trusted
  // client IP is required and restarting the app cannot reset the limit.
  const result = await db
    .collection<{ _id: string; windowStart: number; attempts: number }>(
      "public_pin_attempts",
    )
    .findOneAndUpdate(
      { _id: "shared" },
      [
        {
          $set: {
            windowStart: { $cond: [expired, now, "$windowStart"] },
            attempts: {
              $cond: [
                expired,
                1,
                { $add: [{ $ifNull: ["$attempts", 0] }, 1] },
              ],
            },
          },
        },
      ],
      { upsert: true, returnDocument: "after" },
    );
  if (!result) throw new Error("PIN attempt counter could not be updated.");
  return result.attempts <= MAX_ATTEMPTS;
}
