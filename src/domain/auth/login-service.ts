import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { UserService } from "./user-service";
import { normalizeEmail } from "./email";
import { recordAuthEvent, isNewDevice } from "./auth-events";
import { emailHash, ipHash, UNKNOWN_CONTEXT, type RequestContext } from "./request-context";
import {
  ACCOUNT_POLICY,
  IP_POLICY,
  clearBucket,
  purgeStaleThrottles,
  recordFailure,
  remainingLockSeconds,
} from "./login-throttle";

/**
 * THE sign-in decision (master spec 47; docs/security.md section 22). NextAuth's Credentials `authorize` calls this and
 * nothing else; it issues no session itself, it only says yes or no. Order of work, each step deliberate:
 *
 *  1. Locked? One SELECT on the account and address buckets. A locked caller is refused BEFORE any password work, and the
 *     refusal is the same for an account that exists and one that does not (the counters are keyed on the typed email).
 *     Refused attempts write nothing, so a flood against a locked account costs one SELECT each and grows no table.
 *  2. Password check with uniform cost (UserService.checkPassword always runs bcrypt, against a dummy hash for an unknown
 *     email). Unknown email, wrong password and suspended account are one indistinguishable outcome: `invalid`.
 *  3. A failure counts against the account AND the address (two atomic upserts) and is audited. Reaching the limit starts
 *     a lock (and is audited as `login_locked`), but THIS response is still `invalid` - the next attempt sees the lock.
 *  4. Success clears the account counter, stamps `users.last_login_at`, and audits the sign-in with a coarse "new device
 *     or location" flag.
 *
 * Seat limits, suspension and archived-organisation behaviour are NOT touched here: they are enforced per request by
 * getCurrentUser / requireOrgAndActor exactly as before.
 */
export type LoginResult =
  | { status: "ok"; user: { id: string; email: string; name: string } }
  | { status: "invalid" }
  | { status: "locked"; retryAfterSeconds: number };

export interface AuthenticateInput {
  email: string;
  password: string;
  context?: RequestContext;
}

/** About 1 in this many failures also purges stale counter rows, so the table stays bounded without a cron job. */
const PURGE_ONE_IN = 50;

export const LoginService = {
  async authenticate(input: AuthenticateInput): Promise<LoginResult> {
    const context = input.context ?? UNKNOWN_CONTEXT;
    const email = normalizeEmail(input.email);
    const accountBucket = `acct:${emailHash(email)}`;
    const ipBucket = `ip:${ipHash(context.ip)}`;

    const lockedFor = await remainingLockSeconds([accountBucket, ipBucket]);
    if (lockedFor > 0) {
      return { status: "locked", retryAfterSeconds: lockedFor };
    }

    const user = await UserService.checkPassword(email, input.password);
    if (!user) {
      await LoginService.registerFailure(email, null, context, "password");
      return { status: "invalid" };
    }

    return LoginService.complete(user, context);
  },

  /** Counts a failed attempt against the account and the address, audits it, and audits a lock if one just began. */
  async registerFailure(email: string, userId: string | null, context: RequestContext, detail: string): Promise<void> {
    const account = await recordFailure(`acct:${emailHash(email)}`, ACCOUNT_POLICY);
    const address = await recordFailure(`ip:${ipHash(context.ip)}`, IP_POLICY);
    await recordAuthEvent({ event: "login_failed", userId, email, context, detail });
    if (account.justLocked) await recordAuthEvent({ event: "login_locked", userId, email, context, detail: "account" });
    if (address.justLocked) await recordAuthEvent({ event: "login_locked", userId: null, email: null, context, detail: "address" });
    if (Math.floor(Math.random() * PURGE_ONE_IN) === 0) await purgeStaleThrottles();
  },

  /** The final step of a successful sign-in (after every factor has passed). */
  async complete(
    user: { id: string; email: string; name: string },
    context: RequestContext,
  ): Promise<LoginResult> {
    const email = normalizeEmail(user.email);
    const newDevice = await isNewDevice(user.id, context);
    await clearBucket(`acct:${emailHash(email)}`);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await recordAuthEvent({ event: "login_success", userId: user.id, email, context, newDevice });
    return { status: "ok", user: { id: user.id, email: user.email, name: user.name } };
  },
};
