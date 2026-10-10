import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { hasValidPublicPin, PUBLIC_PIN_COOKIE } from "@/lib/public-pin";

export async function requirePublicAccess() {
  const session = await auth();
  if (session?.user?.id) return;
  const token = (await cookies()).get(PUBLIC_PIN_COOKIE)?.value;
  if (!hasValidPublicPin(token)) redirect("/pin");
}
