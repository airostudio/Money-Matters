import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { LoginService } from "@/domain/auth/login-service";
import { requestContextFromHeaders } from "@/domain/auth/request-context";

/**
 * NextAuth (Credentials + JWT sessions) — see
 * docs/decisions/0002-auth-strategy.md for why, and for the swap plan to
 * Supabase Auth before production. Nothing outside this file and
 * src/domain/auth/* knows *how* the user authenticated;
 * every domain service only ever sees a resolved Actor (src/lib/session.ts).
 *
 * `authorize` delegates the whole decision to LoginService (throttling, lockout, uniform-cost password check, audit):
 * it returns a user only when every check has passed, and NextAuth issues the session cookie only for a returned user.
 * A refusal is either `null` (one generic "invalid" for unknown email / wrong password / suspended) or a thrown error
 * whose message is a stable code the login form understands (LOGIN_ERROR_PREFIX_*); no other detail is ever put in it.
 */
export const LOGIN_LOCKED_PREFIX = "TooManyAttempts:";

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
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;
        const result = await LoginService.authenticate({
          email: credentials.email,
          password: credentials.password,
          context: requestContextFromHeaders(req?.headers),
        });
        if (result.status === "locked") throw new Error(`${LOGIN_LOCKED_PREFIX}${result.retryAfterSeconds}`);
        if (result.status !== "ok") return null;
        return { id: result.user.id, email: result.user.email, name: result.user.name };
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
