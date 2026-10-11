import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { authEvents } from "@/db/schema";
import { emailHash, ipHash, ipPrefixHash, userAgentFamily, type RequestContext } from "./request-context";

/**
 * Append-only platform-level authentication log (`auth_events`, docs/security.md section 22). Never receives a secret,
 * a code, a token or a raw address: callers pass the request context and this module reduces it to keyed hashes and a
 * coarse user-agent family. `detail` is short, fixed-vocabulary text ("password", "totp", "recovery"), never user input.
 */
export type AuthEventType =
  | "login_success"
  | "login_failed"
  | "login_locked"
  | "mfa_enrol_started"
  | "mfa_enabled"
  | "mfa_disabled"
  | "mfa_failed"
  | "mfa_recovery_used"
  | "mfa_recovery_regenerated"
  | "mfa_unavailable"
  | "password_reset_requested"
  | "password_reset_completed"
  | "email_verification_sent"
  | "email_verified";

export interface AuthEventInput {
  event: AuthEventType;
  userId?: string | null;
  /** The normalised email, if known; stored only as a keyed hash. */
  email?: string | null;
  context?: RequestContext | null;
  newDevice?: boolean;
  detail?: string;
}

export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  await db.insert(authEvents).values({
    userId: input.userId ?? null,
    event: input.event,
    emailHash: input.email ? emailHash(input.email) : null,
    ipHash: input.context ? ipHash(input.context.ip) : null,
    ipPrefixHash: input.context ? ipPrefixHash(input.context.ip) : null,
    userAgentFamily: input.context ? userAgentFamily(input.context.userAgent) : null,
    newDevice: input.newDevice ?? false,
    detail: input.detail?.slice(0, 64) ?? null,
  });
}

/**
 * Is this (browser family, network) pair new for the user? True only when the user HAS signed in before and never from
 * this combination in their last 100 sign-ins: the very first sign-in is not "new" (there is nothing to compare with).
 */
export async function isNewDevice(userId: string, context: RequestContext): Promise<boolean> {
  const family = userAgentFamily(context.userAgent);
  const prefix = ipPrefixHash(context.ip);
  const result = await db.execute<{ total: number; same: number }>(sql`
    SELECT count(*)::int AS total,
           (count(*) FILTER (WHERE user_agent_family = ${family} AND ip_prefix_hash = ${prefix}))::int AS same
    FROM (
      SELECT user_agent_family, ip_prefix_hash FROM auth_events
      WHERE user_id = ${userId}::uuid AND event = 'login_success'
      ORDER BY created_at DESC LIMIT 100
    ) recent
  `);
  const row = result.rows[0];
  return !!row && Number(row.total) > 0 && Number(row.same) === 0;
}

export interface RecentSignIn {
  at: Date;
  userAgentFamily: string | null;
  newDevice: boolean;
}

/** The user's most recent successful sign-ins, newest first (for the security page). */
export async function recentSignIns(userId: string, limit = 8): Promise<RecentSignIn[]> {
  const result = await db.execute<{ created_at: Date; user_agent_family: string | null; new_device: boolean }>(sql`
    SELECT created_at, user_agent_family, new_device FROM auth_events
    WHERE user_id = ${userId}::uuid AND event = 'login_success'
    ORDER BY created_at DESC LIMIT ${limit}
  `);
  return result.rows.map((r) => ({ at: new Date(r.created_at), userAgentFamily: r.user_agent_family, newDevice: Boolean(r.new_device) }));
}

export interface LockoutRow {
  at: Date;
  /** First characters of the keyed email hash: lets an admin see repeats without learning the address. */
  accountKey: string | null;
  userAgentFamily: string | null;
  detail: string | null;
}

/** Recent lockout events for the platform admin (newest first). */
export async function recentLockouts(limit = 50): Promise<LockoutRow[]> {
  const result = await db.execute<{ created_at: Date; email_hash: string | null; user_agent_family: string | null; detail: string | null }>(sql`
    SELECT created_at, email_hash, user_agent_family, detail FROM auth_events
    WHERE event = 'login_locked' ORDER BY created_at DESC LIMIT ${limit}
  `);
  return result.rows.map((r) => ({ at: new Date(r.created_at), accountKey: r.email_hash ? r.email_hash.slice(0, 10) : null, userAgentFamily: r.user_agent_family, detail: r.detail }));
}
