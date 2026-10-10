/**
 * Tunable limits for organisation lifecycle and joining. Plain constants (no environment variable): changing one is a
 * reviewed code change, and the values are documented in docs/security.md section 17.
 */

/**
 * Most ACTIVE (non-archived) companies one person may own (be an OWNER of). Archived companies do not count, which is
 * what makes archive useful; restoring an archived company is therefore also refused while the person is at this cap
 * (otherwise archive-then-create-then-restore would be a way round it). Creating a company through registration is
 * not counted against anyone (the person has no companies yet).
 */
export const MAX_OWNED_ACTIVE_COMPANIES = 5;

/** Create-another-company attempts per person per window, per server instance (best effort - see docs/security.md section 17). */
export const COMPANY_CREATE_THROTTLE_MAX = 10;
export const COMPANY_CREATE_THROTTLE_WINDOW_MS = 60 * 60 * 1000;

/** How long an invite code stays redeemable. */
export const INVITE_TTL_DAYS = 7;

/** Most PENDING (unused, unrevoked, unexpired) invites one organization may hold at once. */
export const MAX_PENDING_INVITES_PER_ORG = 10;

/** Failed redemptions allowed per person / per address per window before further attempts are refused (per server instance, best effort). */
export const INVITE_REDEEM_THROTTLE_MAX_FAILURES = 5;
export const INVITE_REDEEM_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
