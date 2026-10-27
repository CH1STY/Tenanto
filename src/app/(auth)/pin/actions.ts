"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  createPublicPinToken,
  matchesPublicPin,
  PUBLIC_PIN_COOKIE,
  PUBLIC_PIN_MAX_AGE,
  safePinReturnTo,
} from "@/lib/public-pin";
import {
  pinLockoutMessage,
  publicPinRetryAfter,
  recordFailedPublicPinAttempt,
} from "@/lib/public-pin-attempts";

export type PinState = { error: string | null };

export async function unlockPublicPages(
  _previous: PinState,
  formData: FormData,
): Promise<PinState> {
  const returnTo = safePinReturnTo(formData.get("returnTo"));
  const session = await auth();
  if (session?.user?.id) redirect(returnTo);

  // Validate first: only failures consume the shared budget. A correct PIN is
  // still refused during a lockout so a brute-forcer cannot confirm a hit.
  if (!matchesPublicPin(formData.get("pin"))) {
    const wait = await recordFailedPublicPinAttempt();
    if (wait > 0) return { error: pinLockoutMessage(wait) };
    return { error: "Incorrect PIN. Enter the access PIN." };
  }
  const wait = await publicPinRetryAfter();
  if (wait > 0) return { error: pinLockoutMessage(wait) };

  (await cookies()).set(PUBLIC_PIN_COOKIE, createPublicPinToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: PUBLIC_PIN_MAX_AGE,
  });
  redirect(returnTo);
}
