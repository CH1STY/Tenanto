import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PUBLIC_PIN_COOKIE = "tenant-public-access";
export const PUBLIC_PIN_MAX_AGE = 6 * 60 * 60;

function configuration() {
  const pin = process.env.PUBLIC_ACCESS_PIN;
  const secret = process.env.AUTH_SECRET;
  if (!pin || !/^\d{4}$/.test(pin)) {
    throw new Error("PUBLIC_ACCESS_PIN must be exactly four digits.");
  }
  if (!secret) throw new Error("AUTH_SECRET is required for PIN access.");
  return { pin, secret };
}

function signature(payload: string) {
  const { pin, secret } = configuration();
  return createHmac("sha256", secret)
    .update(`public-pin:${pin}:${payload}`)
    .digest("base64url");
}

export function matchesPublicPin(value: unknown): boolean {
  const { pin } = configuration();
  return (
    typeof value === "string" &&
    /^\d{4}$/.test(value) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(pin))
  );
}

export function createPublicPinToken(now = Date.now()): string {
  const payload = `v1.${Math.floor(now / 1000)}.${randomBytes(16).toString("hex")}`;
  return `${payload}.${signature(payload)}`;
}

export function hasValidPublicPin(
  token: string | undefined,
  now = Date.now(),
): boolean {
  configuration();
  if (!token || !/^v1\.\d{10,}\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(token)) {
    return false;
  }
  const [version, issued, nonce, supplied] = token.split(".");
  const issuedAt = Number(issued);
  const seconds = Math.floor(now / 1000);
  if (
    !Number.isSafeInteger(issuedAt) ||
    issuedAt > seconds ||
    seconds >= issuedAt + PUBLIC_PIN_MAX_AGE
  ) {
    return false;
  }
  const expected = signature(`${version}.${issued}.${nonce}`);
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function publicAccessAllowed(
  signedIn: boolean,
  token: string | undefined,
  now = Date.now(),
): boolean {
  return signedIn || hasValidPublicPin(token, now);
}

export function safePinReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020]/.test(value)
  ) {
    return "/";
  }
  const url = new URL(value, "http://localhost");
  if (
    url.pathname === "/pin" ||
    url.pathname.startsWith("/pin/") ||
    url.pathname === "/login" ||
    url.pathname.startsWith("/api/auth")
  ) {
    return "/";
  }
  return `${url.pathname}${url.search}`;
}
