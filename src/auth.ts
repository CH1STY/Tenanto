import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

import { authConfig } from "@/auth.config";
import { connectDB } from "@/lib/db";
import { User } from "@/models/User";
import { LOGIN_ROLES } from "@/lib/constants";
import { loginSchema } from "@/lib/validators/auth";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = loginSchema.safeParse(raw);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;
        await connectDB();

        // passwordHash is select:false in the schema, so request it explicitly.
        const user = await User.findOne({ email })
          .select("+passwordHash name email role isActive")
          .lean();

        // Generic failures — never reveal which check failed (no user enumeration).
        if (!user || !user.passwordHash) return null;
        if (!user.isActive) return null;
        if (!LOGIN_ROLES.includes(user.role as (typeof LOGIN_ROLES)[number])) {
          return null;
        }

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

        return {
          id: String(user._id),
          name: user.name,
          email: user.email ?? undefined,
          role: user.role,
        };
      },
    }),
  ],
});
