import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { normalizeEmail } from "@/domain/auth/email";

/**
 * Platform admin identity gate — docs/security.md "Platform admin".
 *
 * The set of platform admins is the server-side environment variable
 * PLATFORM_ADMIN_EMAILS (comma-separated). It is never hardcoded, never sent to
 * the client, and FAILS CLOSED: unset, empty, or only whitespace/commas means
 * nobody is an admin. Both sides of the comparison go through the same
 * normalisation registration uses (trim + lowercase), and the database
 * guarantees at most one account per normalised address, so a case-variant
 * look-alike can neither pass the gate nor create a second account.
 */
export function parsePlatformAdminEmails(raw: string | undefined | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map(normalizeEmail)
      .filter((e) => e.length > 0),
  );
}

export function isPlatformAdminEmail(
  email: string | undefined | null,
  raw: string | undefined | null = process.env.PLATFORM_ADMIN_EMAILS,
): boolean {
  if (!email) return false;
  const normalized = normalizeEmail(email);
  if (normalized.length === 0) return false;
  return parsePlatformAdminEmails(raw).has(normalized);
}

/** A verified platform admin. Only ever produced by `requirePlatformAdmin()` / `verifyPlatformAdmin()`. */
export interface PlatformAdmin {
  userId: string;
  email: string;
}

export class PlatformAdminRequiredError extends Error {
  constructor() {
    super("This operation requires platform administrator access.");
    this.name = "PlatformAdminRequiredError";
  }
}

/**
 * Re-verifies, against the database, that `userId` is an active (not
 * suspended) user whose stored email is in PLATFORM_ADMIN_EMAILS. Every
 * PlatformAdminService method calls this first, so the domain layer refuses a
 * non-admin even if a caller (a server action, a test, a future route)
 * forgot or bypassed the page-level gate — defence in depth, since server
 * actions are directly invocable. One primary-key query.
 */
export async function verifyPlatformAdmin(userId: string | undefined | null): Promise<PlatformAdmin> {
  if (
    !userId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) ||
    parsePlatformAdminEmails(process.env.PLATFORM_ADMIN_EMAILS).size === 0
  ) {
    throw new PlatformAdminRequiredError();
  }
  const [user] = await db
    .select({ id: users.id, email: users.email, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!user || user.disabledAt || !isPlatformAdminEmail(user.email)) {
    throw new PlatformAdminRequiredError();
  }
  return { userId: user.id, email: user.email };
}
