import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { normalizeEmail } from "./email";

const BCRYPT_WORK_FACTOR = 12;

/**
 * A bcrypt hash (work factor 12, same as real accounts) of a random value nobody knows. It is compared against when the
 * email has no account, so the bcrypt cost - the dominant part of sign-in time - is paid either way. Public by design:
 * it protects nothing and matches no password.
 */
export const DUMMY_PASSWORD_HASH = "$2a$12$YkYT30bY/S.WS0x0AzVYV.L2SiU0gJtXL5/eAKcnjsu2kN8Pvmugm";

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
    // Normalised on write, and the database enforces it (CHECK + a
    // case-insensitive unique index): there is no email verification, so a
    // case-variant of a privileged address (the platform admin's) must never
    // be able to become a second account. See docs/security.md.
    const email = normalizeEmail(input.email);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw new EmailAlreadyRegisteredError(email);

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_WORK_FACTOR);
    try {
      const [user] = await db
        .insert(users)
        .values({ email, name: input.name, passwordHash })
        .returning({ id: users.id, email: users.email, name: users.name });
      if (!user) throw new Error("Failed to register user.");
      return user;
    } catch (error) {
      // Two simultaneous registrations of the same address: the unique index
      // decides, and the loser gets the same friendly error as the check above.
      if (isUniqueViolation(error)) throw new EmailAlreadyRegisteredError(email);
      throw error;
    }
  },

  /**
   * Checks an email + password with UNIFORM work: bcrypt always runs (against a fixed dummy hash when the account does
   * not exist or has no password), so an unknown email costs the same as a wrong password and response time does not
   * reveal whether an account exists. A suspended account is checked AFTER the hash comparison and is
   * indistinguishable from a wrong password to the caller (no account-state oracle). Returns the user row, or null.
   */
  async checkPassword(email: string, password: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));

    const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user?.passwordHash || !valid) return null;
    if (user.disabledAt) return null;
    return user;
  },

  async verifyCredentials(email: string, password: string) {
    const user = await UserService.checkPassword(email, password);
    return user ? { id: user.id, email: user.email, name: user.name } : null;
  },

  /**
   * The authoritative identity for an already-issued session: one primary-key
   * lookup that also enforces suspension. Returns null if the user no longer
   * exists or has been suspended — which is how a suspended user's existing
   * JWT stops working (see src/lib/session.ts and docs/security.md).
   */
  async getActiveIdentity(userId: string) {
    const [user] = await db
      .select({ id: users.id, email: users.email, name: users.name, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!user || user.disabledAt) return null;
    return { id: user.id, email: user.email, name: user.name };
  },
};

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code ??
    (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505";
}
