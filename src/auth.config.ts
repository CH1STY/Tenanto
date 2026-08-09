import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe Auth.js config. Contains NO database or Node-only code so it can run
 * inside middleware. The Credentials provider (which needs Mongoose + bcrypt) is
 * added in `src/auth.ts`, which runs in the Node.js runtime.
 */
export const authConfig = {
  pages: {
    signIn: "/login",
  },
  session: { strategy: "jwt" },
  trustHost: true,
  providers: [],
  callbacks: {
    // Route protection used by middleware.
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const path = nextUrl.pathname;

      const isDashboard = path.startsWith("/dashboard");
      const isAdmin = path.startsWith("/admin");
      const isProtected = isDashboard || isAdmin;

      if (isProtected) return isLoggedIn;

      // Signed-in users hitting /login get bounced to the dashboard.
      if (path === "/login" && isLoggedIn) {
        return Response.redirect(new URL("/dashboard", nextUrl));
      }
      return true;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role;
        token.name = user.name;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
