import { roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";
import type { ActorType } from "@/domain/permissions/permission-service";

/**
 * The period lock model (master spec §41). Pure — no database, no I/O — so
 * the whole permission matrix is unit-testable and the posting engine, the
 * close workflow and the UI all read the one definition.
 *
 * Levels, ordered by severity (`LOCK_RANK`; Postgres' enum order is creation
 * order and is NOT the severity order):
 *
 *   OPEN            normal posting.
 *   SOFT_LOCKED     a warning state: routine users cannot post; a holder of
 *                   `period:override_soft` may post inline with a mandatory,
 *                   audited reason.
 *   ADVISOR_LOCKED  the accountant is still finalising adjustments: only a
 *                   holder of `period:post_advisor_locked` may post (no
 *                   reason needed — it is their normal work — but the entry is
 *                   marked as posted under the lock).
 *   TAX_LOCKED      the period is covered by a lodged return/BAS (a MANUAL
 *                   lock the user applies — there is no tax-lodgement
 *                   integration). Nobody posts; the only way back is the
 *                   audited reopen workflow, because a change would invalidate
 *                   the lodgement.
 *   HARD_LOCKED     nobody posts, ever, inline. Only the audited reopen
 *                   workflow lowers it.
 */
export const LOCK_LEVELS = ["OPEN", "SOFT_LOCKED", "ADVISOR_LOCKED", "TAX_LOCKED", "HARD_LOCKED"] as const;
export type LockLevel = (typeof LOCK_LEVELS)[number];

export const LOCK_RANK: Record<LockLevel, number> = {
  OPEN: 0,
  SOFT_LOCKED: 1,
  ADVISOR_LOCKED: 2,
  TAX_LOCKED: 3,
  HARD_LOCKED: 4,
};

export const LOCK_LABELS: Record<LockLevel, string> = {
  OPEN: "Open",
  SOFT_LOCKED: "Soft lock",
  ADVISOR_LOCKED: "Advisor lock",
  TAX_LOCKED: "Tax lock",
  HARD_LOCKED: "Hard lock",
};

/** One-line plain-language consequence of each level (shown beside every level picker and in rejection messages). */
export const LOCK_DESCRIPTIONS: Record<LockLevel, string> = {
  OPEN: "Anyone with posting permission can post into this period.",
  SOFT_LOCKED:
    "Routine users cannot post. An accountant, administrator or owner can still post inline, but must give a reason that is recorded.",
  ADVISOR_LOCKED:
    "Only accountant-level roles (accountant, administrator, owner) can post; bookkeepers and everyone else cannot.",
  TAX_LOCKED:
    "Covered by a lodged tax return/BAS. No one can post — the period must be reopened (with a reason and an acknowledgement that this may invalidate the lodgement) first.",
  HARD_LOCKED:
    "No one can post, not even the owner. The period must be reopened through the audited reopen workflow first.",
};

export const MIN_REASON_LENGTH = 10;

/** Ordering helpers. */
export function lockRank(level: LockLevel): number {
  return LOCK_RANK[level];
}
export function isLocked(level: LockLevel): boolean {
  return level !== "OPEN";
}
export function mostRestrictive(levels: LockLevel[]): LockLevel {
  return levels.reduce<LockLevel>((acc, l) => (LOCK_RANK[l] > LOCK_RANK[acc] ? l : acc), "OPEN");
}
export function isLockLevel(value: string): value is LockLevel {
  return (LOCK_LEVELS as readonly string[]).includes(value);
}

/** The level a close may apply: anything but OPEN. */
export const CLOSE_LOCK_LEVELS: readonly LockLevel[] = ["SOFT_LOCKED", "ADVISOR_LOCKED", "TAX_LOCKED", "HARD_LOCKED"];

// ---------------------------------------------------------------------------
// Posting decision
// ---------------------------------------------------------------------------

export type PostingDenialCode =
  /** SOFT_LOCKED, the actor may override, but supplied no (valid) reason. */
  | "OVERRIDE_REASON_REQUIRED"
  /** SOFT_LOCKED and the actor's role cannot override it. */
  | "SOFT_LOCKED_NOT_AUTHORISED"
  | "ADVISOR_LOCKED_NOT_AUTHORISED"
  | "TAX_LOCKED"
  | "HARD_LOCKED";

export type PostingDecision =
  | {
      allowed: true;
      /** Non-null when the posting is made UNDER a lock and must be recorded as such. */
      overrideLevel: LockLevel | null;
      overrideReason: string | null;
    }
  | {
      allowed: false;
      code: PostingDenialCode;
      /** True when the actor could post inline by supplying a (valid) reason — the UI then offers "Post anyway". */
      canOverrideWithReason: boolean;
    };

export interface PostingDecisionInput {
  level: LockLevel;
  role: MembershipRole;
  /** Defaults to HUMAN. Only a human can ever act under a lock. */
  actorType?: ActorType;
  /** The reason the actor supplied for an inline override, if any. */
  overrideReason?: string | null;
}

export function normaliseReason(reason: string | null | undefined): string {
  return (reason ?? "").trim();
}

export function isValidReason(reason: string | null | undefined): boolean {
  return normaliseReason(reason).length >= MIN_REASON_LENGTH;
}

function can(role: MembershipRole, permission: Permission): boolean {
  return roleHasPermission(role, permission);
}

/**
 * Given a period's lock level, who is posting and any override reason, may
 * the posting proceed — and if so, must it be recorded as made under the
 * lock? THE single authority the posting engine consults; the authorisation
 * comes from the server-side role, never from a client-supplied flag (the
 * only client input is the free-text reason).
 */
export function evaluatePosting(input: PostingDecisionInput): PostingDecision {
  const { level, role } = input;
  const human = (input.actorType ?? "HUMAN") === "HUMAN";

  switch (level) {
    case "OPEN":
      return { allowed: true, overrideLevel: null, overrideReason: null };
    case "SOFT_LOCKED": {
      if (!human || !can(role, "period:override_soft")) {
        return { allowed: false, code: "SOFT_LOCKED_NOT_AUTHORISED", canOverrideWithReason: false };
      }
      if (!isValidReason(input.overrideReason)) {
        return { allowed: false, code: "OVERRIDE_REASON_REQUIRED", canOverrideWithReason: true };
      }
      return { allowed: true, overrideLevel: "SOFT_LOCKED", overrideReason: normaliseReason(input.overrideReason) };
    }
    case "ADVISOR_LOCKED": {
      if (!human || !can(role, "period:post_advisor_locked")) {
        return { allowed: false, code: "ADVISOR_LOCKED_NOT_AUTHORISED", canOverrideWithReason: false };
      }
      const reason = normaliseReason(input.overrideReason);
      return { allowed: true, overrideLevel: "ADVISOR_LOCKED", overrideReason: reason || null };
    }
    case "TAX_LOCKED":
      return { allowed: false, code: "TAX_LOCKED", canOverrideWithReason: false };
    case "HARD_LOCKED":
      return { allowed: false, code: "HARD_LOCKED", canOverrideWithReason: false };
  }
}

// ---------------------------------------------------------------------------
// Lock-change (lock / reopen) validation
// ---------------------------------------------------------------------------

export const TAX_REOPEN_ACK_PHRASE = "may invalidate a lodgement";

export type LockChangeKind = "NO_CHANGE" | "RAISE" | "LOWER";

export function classifyLockChange(from: LockLevel, to: LockLevel): LockChangeKind {
  if (LOCK_RANK[to] === LOCK_RANK[from]) return "NO_CHANGE";
  return LOCK_RANK[to] > LOCK_RANK[from] ? "RAISE" : "LOWER";
}

/** Permission needed to change `from` -> `to` (null for no change). */
export function permissionForLockChange(from: LockLevel, to: LockLevel): Permission | null {
  const kind = classifyLockChange(from, to);
  if (kind === "NO_CHANGE") return null;
  if (kind === "RAISE") return "period:close";
  // Lowering: leaving TAX/HARD needs the most restricted permission.
  return LOCK_RANK[from] >= LOCK_RANK.TAX_LOCKED ? "period:reopen_hard" : "period:reopen";
}

export type LockChangeProblem =
  | "NO_CHANGE"
  | "NOT_PERMITTED"
  | "REASON_REQUIRED"
  | "TAX_ACKNOWLEDGEMENT_REQUIRED";

export interface LockChangeInput {
  from: LockLevel;
  to: LockLevel;
  role: MembershipRole;
  actorType?: ActorType;
  reason?: string | null;
  acknowledgement?: string | null;
}

export type LockChangeDecision =
  | { ok: true; kind: "RAISE" | "LOWER"; requiredPermission: Permission }
  | { ok: false; problem: LockChangeProblem; requiredPermission: Permission | null };

/**
 * Validates a lock change. Raising a lock needs `period:close` (a reason is
 * optional but recorded); LOWERING one — "reopen" — needs `period:reopen`
 * (or `period:reopen_hard` when the period is TAX_LOCKED/HARD_LOCKED) AND a
 * reason of at least `MIN_REASON_LENGTH` characters; leaving TAX_LOCKED
 * additionally needs the typed acknowledgement that it may invalidate a
 * lodgement. An AI/SYSTEM actor is never permitted.
 */
export function evaluateLockChange(input: LockChangeInput): LockChangeDecision {
  const kind = classifyLockChange(input.from, input.to);
  if (kind === "NO_CHANGE") return { ok: false, problem: "NO_CHANGE", requiredPermission: null };
  const requiredPermission = permissionForLockChange(input.from, input.to) as Permission;
  const human = (input.actorType ?? "HUMAN") === "HUMAN";
  if (!human || !can(input.role, requiredPermission)) {
    return { ok: false, problem: "NOT_PERMITTED", requiredPermission };
  }
  if (kind === "LOWER") {
    if (!isValidReason(input.reason)) return { ok: false, problem: "REASON_REQUIRED", requiredPermission };
    if (input.from === "TAX_LOCKED" && !acknowledgesTaxLodgement(input.acknowledgement)) {
      return { ok: false, problem: "TAX_ACKNOWLEDGEMENT_REQUIRED", requiredPermission };
    }
  }
  return { ok: true, kind, requiredPermission };
}

/** The TAX_LOCKED reopen acknowledgement must contain the phrase (case/space-insensitive). */
export function acknowledgesTaxLodgement(text: string | null | undefined): boolean {
  return normaliseReason(text).toLowerCase().replace(/\s+/g, " ").includes(TAX_REOPEN_ACK_PHRASE);
}

/** Who can reopen a period at `level`, in plain words (rejection messages, UI hints; master spec §79). */
export function whoCanReopen(level: LockLevel): string {
  if (level === "OPEN") return "Nobody needs to — it is already open.";
  return LOCK_RANK[level] >= LOCK_RANK.TAX_LOCKED
    ? "Only an Owner or Administrator can reopen it"
    : "An Accountant, Administrator or Owner can reopen it";
}
