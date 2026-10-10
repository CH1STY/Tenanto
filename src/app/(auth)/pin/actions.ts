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
import { consumePublicPinAttempt } from "@/lib/public-pin-attempts";

export type PinState = { error: string | null };

export async function unlockPublicPages(
  _previous: PinState,
  formData: FormData,
): Promise<PinState> {
  const returnTo = safePinReturnTo(formData.get("returnTo"));
  const session = await auth();
  if (session?.user?.id) redirect(returnTo);

  const valid = matchesPublicPin(formData.get("pin"));
  if (!(await consumePublicPinAttempt())) {
    return { error: "Too many PIN attempts. Please try again in one minute." };
  }
  if (!valid) return { error: "Incorrect PIN. Enter the four-digit access PIN." };

  (await cookies()).set(PUBLIC_PIN_COOKIE, createPublicPinToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: PUBLIC_PIN_MAX_AGE,
  });
  redirect(returnTo);
}
