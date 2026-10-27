"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import {
  loginLockoutMessage,
  reserveLoginAttempt,
  settleLoginAttempt,
} from "@/lib/login-attempts";
import { loginSchema } from "@/lib/validators/auth";

// `email` is echoed back on failure so the form keeps it after React resets it.
export type LoginState = { error: string | null; email?: string };

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return {
      error: "Enter a valid email and password.",
      email: String(formData.get("email") ?? ""),
    };
  }

  const attempt = await reserveLoginAttempt(parsed.data.email);
  if (!attempt.allowed) {
    return {
      error: loginLockoutMessage(attempt.retryAfterMs),
      email: parsed.data.email,
    };
  }

  let destination: string;
  try {
    // redirect: false makes success return the destination instead of
    // throwing a redirect, so success and failure can be told apart reliably.
    // Failed credentials still throw an AuthError.
    destination = await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: "/dashboard",
      redirect: false,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      await settleLoginAttempt(attempt.reservation, "failure");
      // Generic message — do not reveal whether the email or password was wrong.
      return { error: "Invalid email or password.", email: parsed.data.email };
    }
    await settleLoginAttempt(attempt.reservation, "error").catch(() => {});
    throw error;
  }

  // The session cookie is already set; a counter hiccup must not fail sign-in.
  await settleLoginAttempt(attempt.reservation, "success").catch(() => {});
  redirect(destination);
}
