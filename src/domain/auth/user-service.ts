import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/db/client";
import { users } from "@/db/schema";

const BCRYPT_WORK_FACTOR = 12;

export class EmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(`An account already exists for "${email}".`);
    this.name = "EmailAlreadyRegisteredError";
  }
}

export interface RegisterUserInput {
  email: string;
  name: string;
  password: string;
}

/**
 * Phase 1 identity: local email/password via NextAuth's Credentials
 * provider — see docs/decisions/0002-auth-strategy.md. Supabase Auth (or
 * another provider) is the intended production target; this is the only
 * module that would need to change to swap it in.
 */
export const UserService = {
  async register(input: RegisterUserInput) {
    const email = input.email.trim().toLowerCase();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw new EmailAlreadyRegisteredError(email);

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_WORK_FACTOR);
    const [user] = await db
      .insert(users)
      .values({ email, name: input.name, passwordHash })
      .returning({ id: users.id, email: users.email, name: users.name });
    if (!user) throw new Error("Failed to register user.");
    return user;
  },

  async verifyCredentials(email: string, password: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()));
    if (!user?.passwordHash) return null;

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return null;

    return { id: user.id, email: user.email, name: user.name };
  },
};
