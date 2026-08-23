import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { UserService } from "@/domain/auth/user-service";

/**
 * NextAuth (Credentials + JWT sessions) — see
 * docs/decisions/0002-auth-strategy.md for why, and for the swap plan to
 * Supabase Auth before production. Nothing outside this file and
 * src/domain/auth/user-service.ts knows *how* the user authenticated;
 * every domain service only ever sees a resolved Actor (src/lib/session.ts).
 */
export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const user = await UserService.verifyCredentials(credentials.email, credentials.password);
        if (!user) return null;
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.userId) {
        session.user.id = token.userId;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};
