import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

// Runs on every matched route. Uses only edge-safe config (no DB).
export default auth((req) => {
  const { nextUrl } = req;
  const isLoggedIn = !!req.auth;
  const role = (req.auth?.user as { role?: string } | undefined)?.role;

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
  // Protect app routes; skip static assets and the auth API.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
