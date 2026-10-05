import { describe, expect, it } from "vitest";
import {
  LOCK_LEVELS,
  LOCK_RANK,
  MIN_REASON_LENGTH,
  acknowledgesTaxLodgement,
  classifyLockChange,
  evaluateLockChange,
  evaluatePosting,
  isValidReason,
  mostRestrictive,
  permissionForLockChange,
  whoCanReopen,
  type LockLevel,
} from "@/domain/ledger/period-lock";
import { PERMISSIONS, ROLE_PERMISSIONS, roleHasPermission, type MembershipRole } from "@/domain/permissions/roles";
import { PeriodLockedError } from "@/domain/ledger/errors";

const ROLES = Object.keys(ROLE_PERMISSIONS) as MembershipRole[];
const GOOD_REASON = "Late supplier invoice for the period";

describe("lock level ordering", () => {
  it("orders OPEN < SOFT < ADVISOR < TAX < HARD", () => {
    expect([...LOCK_LEVELS].sort((a, b) => LOCK_RANK[a] - LOCK_RANK[b])).toEqual([
      "OPEN",
      "SOFT_LOCKED",
      "ADVISOR_LOCKED",
      "TAX_LOCKED",
      "HARD_LOCKED",
    ]);
    expect(mostRestrictive(["SOFT_LOCKED", "TAX_LOCKED", "OPEN"])).toBe("TAX_LOCKED");
    expect(mostRestrictive([])).toBe("OPEN");
  });
});

describe("posting decision matrix (level x role x reason)", () => {
  const overriders: MembershipRole[] = ["OWNER", "ADMINISTRATOR", "ACCOUNTANT"];

  it("OPEN allows everyone and records no override", () => {
    for (const role of ROLES) {
      expect(evaluatePosting({ level: "OPEN", role })).toEqual({ allowed: true, overrideLevel: null, overrideReason: null });
    }
  });

  it("SOFT_LOCKED: only period:override_soft roles, and only with a valid reason", () => {
    for (const role of ROLES) {
      const allowedRole = overriders.includes(role);
      expect(roleHasPermission(role, "period:override_soft")).toBe(allowedRole);

      const noReason = evaluatePosting({ level: "SOFT_LOCKED", role });
      const shortReason = evaluatePosting({ level: "SOFT_LOCKED", role, overrideReason: "too short" });
      const withReason = evaluatePosting({ level: "SOFT_LOCKED", role, overrideReason: GOOD_REASON });
      if (allowedRole) {
        expect(noReason).toMatchObject({ allowed: false, code: "OVERRIDE_REASON_REQUIRED", canOverrideWithReason: true });
        expect(shortReason).toMatchObject({ allowed: false, code: "OVERRIDE_REASON_REQUIRED" });
        expect(withReason).toEqual({ allowed: true, overrideLevel: "SOFT_LOCKED", overrideReason: GOOD_REASON });
      } else {
        // A reason never helps a role that is not authorised — the authority is the role, not the client input.
        for (const d of [noReason, shortReason, withReason]) {
          expect(d).toMatchObject({ allowed: false, code: "SOFT_LOCKED_NOT_AUTHORISED", canOverrideWithReason: false });
        }
      }
    }
  });

  it("ADVISOR_LOCKED: accountant-level roles post (marked as under the lock); bookkeepers and the rest cannot", () => {
    for (const role of ROLES) {
      const d = evaluatePosting({ level: "ADVISOR_LOCKED", role });
      if (overriders.includes(role)) {
        expect(d).toEqual({ allowed: true, overrideLevel: "ADVISOR_LOCKED", overrideReason: null });
      } else {
        expect(d).toMatchObject({ allowed: false, code: "ADVISOR_LOCKED_NOT_AUTHORISED" });
      }
    }
    expect(evaluatePosting({ level: "ADVISOR_LOCKED", role: "BOOKKEEPER" })).toMatchObject({ allowed: false });
    expect(evaluatePosting({ level: "ADVISOR_LOCKED", role: "ACCOUNTANT", overrideReason: ` ${GOOD_REASON} ` })).toMatchObject({
      allowed: true,
      overrideReason: GOOD_REASON,
    });
  });

  it("TAX_LOCKED and HARD_LOCKED reject EVERY role, even the owner with a reason", () => {
    for (const level of ["TAX_LOCKED", "HARD_LOCKED"] as LockLevel[]) {
      for (const role of ROLES) {
        const d = evaluatePosting({ level, role, overrideReason: GOOD_REASON });
        expect(d, `${level}/${role}`).toMatchObject({ allowed: false, code: level, canOverrideWithReason: false });
      }
    }
  });

  it("a non-human actor (AI/SYSTEM) can never act under a lock, whatever its role", () => {
    for (const actorType of ["AI", "SYSTEM"] as const) {
      expect(evaluatePosting({ level: "SOFT_LOCKED", role: "OWNER", actorType, overrideReason: GOOD_REASON })).toMatchObject({ allowed: false });
      expect(evaluatePosting({ level: "ADVISOR_LOCKED", role: "OWNER", actorType })).toMatchObject({ allowed: false });
      expect(evaluateLockChange({ from: "HARD_LOCKED", to: "OPEN", role: "OWNER", actorType, reason: GOOD_REASON })).toMatchObject({ ok: false, problem: "NOT_PERMITTED" });
      expect(evaluateLockChange({ from: "OPEN", to: "SOFT_LOCKED", role: "OWNER", actorType })).toMatchObject({ ok: false, problem: "NOT_PERMITTED" });
    }
  });

  it("reason validation trims and enforces the minimum length", () => {
    expect(isValidReason(null)).toBe(false);
    expect(isValidReason("   ")).toBe(false);
    expect(isValidReason("x".repeat(MIN_REASON_LENGTH - 1))).toBe(false);
    expect(isValidReason(`  ${"x".repeat(MIN_REASON_LENGTH)}  `)).toBe(true);
  });
});

describe("lock change (lock / reopen) validation", () => {
  it("classifies raise / lower / no change", () => {
    expect(classifyLockChange("OPEN", "SOFT_LOCKED")).toBe("RAISE");
    expect(classifyLockChange("HARD_LOCKED", "SOFT_LOCKED")).toBe("LOWER");
    expect(classifyLockChange("TAX_LOCKED", "TAX_LOCKED")).toBe("NO_CHANGE");
  });

  it("needs period:close to raise; period:reopen to lower SOFT/ADVISOR; period:reopen_hard to leave TAX/HARD", () => {
    expect(permissionForLockChange("OPEN", "HARD_LOCKED")).toBe("period:close");
    expect(permissionForLockChange("SOFT_LOCKED", "OPEN")).toBe("period:reopen");
    expect(permissionForLockChange("ADVISOR_LOCKED", "SOFT_LOCKED")).toBe("period:reopen");
    expect(permissionForLockChange("TAX_LOCKED", "OPEN")).toBe("period:reopen_hard");
    expect(permissionForLockChange("HARD_LOCKED", "SOFT_LOCKED")).toBe("period:reopen_hard");
    expect(permissionForLockChange("OPEN", "OPEN")).toBeNull();
  });

  it("only OWNER and ADMINISTRATOR hold period:reopen_hard; an accountant can reopen only soft/advisor locks", () => {
    for (const role of ROLES) {
      expect(roleHasPermission(role, "period:reopen_hard"), role).toBe(role === "OWNER" || role === "ADMINISTRATOR");
    }
    const soft = evaluateLockChange({ from: "SOFT_LOCKED", to: "OPEN", role: "ACCOUNTANT", reason: GOOD_REASON });
    expect(soft.ok).toBe(true);
    const hard = evaluateLockChange({ from: "HARD_LOCKED", to: "OPEN", role: "ACCOUNTANT", reason: GOOD_REASON });
    expect(hard).toMatchObject({ ok: false, problem: "NOT_PERMITTED", requiredPermission: "period:reopen_hard" });
    const bookkeeper = evaluateLockChange({ from: "SOFT_LOCKED", to: "OPEN", role: "BOOKKEEPER", reason: GOOD_REASON });
    expect(bookkeeper).toMatchObject({ ok: false, problem: "NOT_PERMITTED" });
  });

  it("reopening requires a reason of at least the minimum length; raising does not", () => {
    expect(evaluateLockChange({ from: "SOFT_LOCKED", to: "OPEN", role: "OWNER" })).toMatchObject({ ok: false, problem: "REASON_REQUIRED" });
    expect(evaluateLockChange({ from: "SOFT_LOCKED", to: "OPEN", role: "OWNER", reason: "short" })).toMatchObject({ ok: false, problem: "REASON_REQUIRED" });
    expect(evaluateLockChange({ from: "OPEN", to: "SOFT_LOCKED", role: "ACCOUNTANT" })).toMatchObject({ ok: true, kind: "RAISE" });
  });

  it("leaving TAX_LOCKED additionally needs the typed lodgement acknowledgement", () => {
    const base = { from: "TAX_LOCKED", to: "OPEN", role: "OWNER", reason: GOOD_REASON } as const;
    expect(evaluateLockChange(base)).toMatchObject({ ok: false, problem: "TAX_ACKNOWLEDGEMENT_REQUIRED" });
    expect(evaluateLockChange({ ...base, acknowledgement: "yes ok" })).toMatchObject({ ok: false, problem: "TAX_ACKNOWLEDGEMENT_REQUIRED" });
    expect(evaluateLockChange({ ...base, acknowledgement: "I understand this  MAY invalidate a lodgement." })).toMatchObject({ ok: true, kind: "LOWER" });
    expect(acknowledgesTaxLodgement("may invalidate a lodgement")).toBe(true);
    // A HARD_LOCKED reopen does not need the tax acknowledgement.
    expect(evaluateLockChange({ from: "HARD_LOCKED", to: "OPEN", role: "OWNER", reason: GOOD_REASON })).toMatchObject({ ok: true });
  });

  it("a no-op change is reported as such", () => {
    expect(evaluateLockChange({ from: "OPEN", to: "OPEN", role: "OWNER" })).toMatchObject({ ok: false, problem: "NO_CHANGE" });
  });
});

describe("role permission matrix for the period/close permissions", () => {
  it("declares every new permission", () => {
    for (const p of ["period:close", "period:reopen", "period:reopen_hard", "period:override_soft", "period:post_advisor_locked", "close_checklist:read", "close_checklist:manage"]) {
      expect(PERMISSIONS).toContain(p);
    }
  });

  it("grants the right roles", () => {
    const holds = (p: Parameters<typeof roleHasPermission>[1]) => ROLES.filter((r) => roleHasPermission(r, p)).sort();
    expect(holds("period:close")).toEqual(["ACCOUNTANT", "ADMINISTRATOR", "OWNER"]);
    expect(holds("period:reopen")).toEqual(["ACCOUNTANT", "ADMINISTRATOR", "OWNER"]);
    expect(holds("period:reopen_hard")).toEqual(["ADMINISTRATOR", "OWNER"]);
    expect(holds("period:override_soft")).toEqual(["ACCOUNTANT", "ADMINISTRATOR", "OWNER"]);
    expect(holds("close_checklist:manage")).toEqual(["ACCOUNTANT", "ADMINISTRATOR", "OWNER"]);
    expect(holds("close_checklist:read")).toEqual(["ACCOUNTANT", "ADMINISTRATOR", "BOOKKEEPER", "MANAGER", "OWNER", "READ_ONLY"]);
  });
});

describe("PeriodLockedError messages explain the consequence and who can reopen", () => {
  it("stays constructible with just a label (backward compatible)", () => {
    const e = new PeriodLockedError("2026-07");
    expect(e.name).toBe("PeriodLockedError");
    expect(e.message).toContain('Fiscal period "2026-07" is locked');
    expect(e.lockLevel).toBeNull();
  });

  it("names the level, the way out and who can do it", () => {
    const hard = new PeriodLockedError("2026-07", { lockLevel: "HARD_LOCKED", denialCode: "HARD_LOCKED" });
    expect(hard.message).toMatch(/no one can post/i);
    expect(hard.message).toContain(whoCanReopen("HARD_LOCKED"));
    const tax = new PeriodLockedError("2026-07", { lockLevel: "TAX_LOCKED", denialCode: "TAX_LOCKED" });
    expect(tax.message).toMatch(/lodge/i);
    const soft = new PeriodLockedError("2026-07", { lockLevel: "SOFT_LOCKED", denialCode: "OVERRIDE_REASON_REQUIRED", canOverrideWithReason: true });
    expect(soft.canOverrideWithReason).toBe(true);
    expect(soft.message).toMatch(/post anyway/i);
    const bk = new PeriodLockedError("2026-07", { lockLevel: "SOFT_LOCKED", denialCode: "SOFT_LOCKED_NOT_AUTHORISED" });
    expect(bk.canOverrideWithReason).toBe(false);
    expect(bk.message).toContain("Accountant");
  });
});
