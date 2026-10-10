import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import {
  PUBLIC_PIN_COOKIE,
  publicAccessAllowed,
  safePinReturnTo,
} from "@/lib/public-pin";

const { auth } = NextAuth(authConfig);

// Runs on matched routes using the JWT auth config without a database query.
export default auth((req) => {
  const { nextUrl } = req;
  const isLoggedIn = !!req.auth;
  const role = (req.auth?.user as { role?: string } | undefined)?.role;

  if (
    nextUrl.pathname !== "/login" &&
    nextUrl.pathname !== "/pin" &&
    !publicAccessAllowed(
      !!req.auth?.user?.id,
      req.cookies.get(PUBLIC_PIN_COOKIE)?.value,
    )
  ) {
    const pinUrl = new URL("/pin", nextUrl);
    pinUrl.searchParams.set(
      "returnTo",
      safePinReturnTo(`${nextUrl.pathname}${nextUrl.search}`),
    );
    return NextResponse.redirect(pinUrl);
  }
  if (
    nextUrl.pathname === "/pin" &&
    (req.auth?.user?.id ||
      (req.cookies.has(PUBLIC_PIN_COOKIE) &&
        publicAccessAllowed(false, req.cookies.get(PUBLIC_PIN_COOKIE)?.value)))
  ) {
    return NextResponse.redirect(
      new URL(safePinReturnTo(nextUrl.searchParams.get("returnTo")), nextUrl),
    );
  }
  // /admin is SuperAdmin-only, except a Manager may enter a specific
  // building's management area (/admin/buildings/<id>...). Assignment to that
  // building is verified with the DB inside the page (edge has no DB).
  if (nextUrl.pathname.startsWith("/admin")) {
    if (!isLoggedIn) {
      return NextResponse.redirect(new URL("/login", nextUrl));
    }
    const inBuildingArea = /^\/admin\/buildings\/[0-9a-fA-F]{24}(\/|$)/.test(
      nextUrl.pathname,
    );
    const allowed =
      role === "SUPER_ADMIN" || (role === "MANAGER" && inBuildingArea);
    if (!allowed) {
      return NextResponse.redirect(new URL("/dashboard", nextUrl));
    }
  }
});

export const config = {
  // Include attachment routes even when their path contains a dot.
  matcher: ["/((?!api/auth(?:/|$)|_next/static|_next/image|favicon\\.ico$).*)"],
};
