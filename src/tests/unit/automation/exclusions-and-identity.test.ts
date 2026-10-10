import { describe, expect, it } from "vitest";
import { ACTION_PERMISSIONS, ACTION_TYPES, AUTOMATION_ALLOWED_PERMISSIONS, TRIGGERS, TRIGGER_READ_PERMISSIONS, isForbiddenForAutomation, permissionsRequiredBy } from "@/domain/automation/vocabulary";
import { requiredPermissions, resolveExecutionIdentity, type AuthoriserState } from "@/domain/automation/identity";
import { assertHumanAutomationManager } from "@/domain/automation/guards";
import { PERMISSIONS, ROLE_PERMISSIONS, roleHasPermission, type MembershipRole } from "@/domain/permissions/roles";
import { ROLES_BY_PRIVILEGE, isWritePermission } from "@/domain/permissions/role-info";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { assertHumanWith } from "@/domain/close/period-lock-service";
import { evaluateLockChange, evaluatePosting } from "@/domain/ledger/period-lock";
import { assertHumanWebhookManager } from "@/domain/webhooks/subscription-service";
import { assertHumanIntegrationManager } from "@/domain/integrations/connection-service";
import { API_ALLOWED_PERMISSIONS, API_SCOPES, SCOPE_INFO, effectivePermissions } from "@/domain/api/scopes";
import { AUTO_APPROVABLE_ACTION_TYPES } from "@/domain/ai-controller/auto-execution-policy";
import { buildControllerTools } from "@/domain/ai-controller/controller-tools";
import { buildWriteTools } from "@/domain/ai-controller/write-tools";

const state = (role: MembershipRole | null, overrides: Partial<AuthoriserState> = {}): AuthoriserState => ({ userId: "u1", role, membershipActive: role !== null, userDisabledAt: null, ...overrides });
const rule = (trigger: (typeof TRIGGERS)[number], actionType: (typeof ACTION_TYPES)[number]) => ({ id: "r1", name: "r", organizationId: "o1", trigger, actionType });

describe("the excluded actions are structurally unreachable", () => {
  it("the action enum is exactly the four low-risk, reversible actions", () => {
    expect([...ACTION_TYPES]).toEqual(["NOTIFY_IN_APP", "SEND_TO_CHANNEL", "EMIT_WEBHOOK_EVENT", "CREATE_DRAFT_PURCHASE_ORDER"]);
    const forbiddenWords = /POST|APPROVE|VOID|PAY|PAYMENT|PAYRUN|BANK|PAYROLL|EMPLOYEE|JOURNAL|PERIOD|CLOSE|LOCK|REOPEN|MEMBER|ROLE|SEAT|API_KEY|WEBHOOK_SUB|INTEGRATION|AUTONOMY|SEND_PO|CONVERT/;
    for (const action of ACTION_TYPES) {
      // EMIT_WEBHOOK_EVENT contains WEBHOOK but is the event emitter, not subscription management.
      expect(action.replace("EMIT_WEBHOOK_EVENT", "EMIT_EVENT"), action).not.toMatch(forbiddenWords);
    }
  });

  it("no action, and no trigger, maps to a forbidden permission (walks the whole mapping)", () => {
    for (const action of ACTION_TYPES) {
      for (const permission of ACTION_PERMISSIONS[action]) {
        expect(isForbiddenForAutomation(permission), `${action} -> ${permission}`).toBe(false);
        expect(AUTOMATION_ALLOWED_PERMISSIONS.has(permission), `${action} -> ${permission}`).toBe(true);
      }
    }
    for (const trigger of TRIGGERS) {
      const permission = TRIGGER_READ_PERMISSIONS[trigger];
      expect(permission.endsWith(":read"), trigger).toBe(true);
      expect(AUTOMATION_ALLOWED_PERMISSIONS.has(permission), trigger).toBe(true);
    }
    for (const trigger of TRIGGERS) for (const action of ACTION_TYPES) for (const p of permissionsRequiredBy(trigger, action)) expect(AUTOMATION_ALLOWED_PERMISSIONS.has(p)).toBe(true);
  });

  it("the allow-list is only reads plus purchase_order:manage; every other write permission in the system is outside it", () => {
    for (const permission of AUTOMATION_ALLOWED_PERMISSIONS) {
      if (permission === "purchase_order:manage") continue;
      expect(isWritePermission(permission), permission).toBe(false);
    }
    const writes = PERMISSIONS.filter((p) => isWritePermission(p) && p !== "purchase_order:manage");
    expect(writes.length).toBeGreaterThan(50);
    for (const permission of writes) expect(AUTOMATION_ALLOWED_PERMISSIONS.has(permission), permission).toBe(false);
  });

  it("the named dangerous permission families are all forbidden by pattern and absent from the allow-list", () => {
    const mustBeForbidden = [
      "journal:post", "journal:reverse", "customer_invoice:post", "customer_invoice:void", "supplier_bill:post", "supplier_bill:void", "supplier_credit:post",
      "customer_payment:manage", "supplier_payment:manage", "payment_run:manage", "payment_run:approve", "bank_account:manage", "bank_transaction:reconcile", "bank_rule:manage",
      "employee:read", "employee:manage", "payrun:manage", "payrun:post", "period:close", "period:reopen", "period:reopen_hard", "period:override_soft",
      "membership:manage", "organization:manage", "api_key:manage", "webhook:manage", "integration:manage", "automation:manage", "expense_claim:approve", "consolidation:manage",
    ];
    for (const permission of mustBeForbidden) {
      expect(PERMISSIONS as readonly string[], permission).toContain(permission);
      expect(isForbiddenForAutomation(permission), permission).toBe(true);
      expect(AUTOMATION_ALLOWED_PERMISSIONS.has(permission as never), permission).toBe(false);
    }
  });

  it("an OWNER-authorised automation identity carries only the narrow set - never OWNER's everything", () => {
    for (const trigger of TRIGGERS) {
      for (const action of ACTION_TYPES) {
        const identity = resolveExecutionIdentity(rule(trigger, action), state("OWNER"));
        expect(identity.ok, `${trigger}/${action}`).toBe(true);
        if (!identity.ok) continue;
        expect(identity.actor.type).toBe("AUTOMATION");
        expect(identity.actor.role).toBe("OWNER"); // role is carried for audit; the grant is what binds
        const granted = [...(identity.actor.grantedPermissions ?? [])];
        expect(granted.length).toBeGreaterThan(0);
        for (const p of granted) expect(AUTOMATION_ALLOWED_PERMISSIONS.has(p), p).toBe(true);
        // assertPermission is the gate every domain service uses: OWNER's role would pass anything, the grant narrows it.
        for (const p of PERMISSIONS) {
          if (granted.includes(p)) expect(() => assertPermission(identity.actor, p)).not.toThrow();
          else expect(() => assertPermission(identity.actor, p), `${p} must be refused`).toThrow(PermissionDeniedError);
        }
      }
    }
  });

  it("an API key can never carry automation, integration, webhook or api-key management, whatever its scopes and creator", () => {
    for (const role of ["OWNER", "ADMINISTRATOR"] as const) {
      const granted = effectivePermissions([...API_SCOPES], role);
      for (const permission of ["automation:read", "automation:manage", "integration:manage", "webhook:manage", "api_key:manage", "purchase_order:manage"] as const) {
        expect(granted.has(permission), `${role} ${permission}`).toBe(false);
        expect(API_ALLOWED_PERMISSIONS.has(permission), permission).toBe(false);
      }
    }
  });

  it("no AI tool, API scope or auto-approvable autonomy item mentions automations or integrations", () => {
    for (const scope of API_SCOPES) {
      expect(scope).not.toMatch(/automation|integration|notification/i);
      for (const permission of SCOPE_INFO[scope].permissions) expect(permission).not.toMatch(/^(automation|integration|webhook|api_key)/);
    }
    for (const type of AUTO_APPROVABLE_ACTION_TYPES) expect(type).not.toMatch(/AUTOMATION|INTEGRATION|NOTIF|CHANNEL|SLACK/i);
    const tools = [...buildControllerTools([]), ...buildWriteTools("question", "model")];
    expect(tools.length).toBeGreaterThan(5);
    for (const tool of tools) {
      expect(tool.name, tool.name).not.toMatch(/automation|integration|slack|notification|channel/i);
      expect(`${tool.description} ${JSON.stringify(tool.inputSchema)}`, tool.name).not.toMatch(/automation rule|integration|slack|pause all automations/i);
    }
  });
});

describe("the AUTOMATION actor type is refused by every human-only check, even with an OWNER role behind it", () => {
  const identity = resolveExecutionIdentity(rule("INVENTORY_BELOW_REORDER", "CREATE_DRAFT_PURCHASE_ORDER"), state("OWNER"));
  if (!identity.ok) throw new Error("fixture");
  const automation: Actor = identity.actor;
  // A raw OWNER actor typed AUTOMATION with NO narrowing at all: the type alone must be enough to be refused.
  const bareOwner: Actor = { userId: "u1", organizationId: "o1", role: "OWNER", type: "AUTOMATION" };

  it("assertHumanWith (period close, checklist sign-off, reopen)", () => {
    for (const permission of ["period:close", "period:reopen", "close_checklist:manage"] as const) {
      expect(() => assertHumanWith(bareOwner, permission)).toThrow(PermissionDeniedError);
      expect(() => assertHumanWith(automation, permission)).toThrow(PermissionDeniedError);
      expect(() => assertHumanWith({ ...bareOwner, type: "HUMAN" }, permission)).not.toThrow(); // the same OWNER as a person passes
    }
  });

  it("evaluatePosting under a period lock", () => {
    for (const level of ["SOFT_LOCKED", "ADVISOR_LOCKED"] as const) {
      const decision = evaluatePosting({ level, role: "OWNER", actorType: "AUTOMATION", overrideReason: "A perfectly good reason" });
      expect(decision.allowed, level).toBe(false);
      expect(evaluatePosting({ level, role: "OWNER", actorType: "HUMAN", overrideReason: "A perfectly good reason" }).allowed, level).toBe(true);
    }
    expect(evaluatePosting({ level: "TAX_LOCKED", role: "OWNER", actorType: "AUTOMATION" }).allowed).toBe(false);
  });

  it("evaluateLockChange (raise, lower, reopen a hard lock)", () => {
    const attempts = [
      { from: "OPEN", to: "SOFT_LOCKED" },
      { from: "SOFT_LOCKED", to: "OPEN", reason: "A long enough reason" },
      { from: "HARD_LOCKED", to: "SOFT_LOCKED", reason: "A long enough reason", acknowledgement: "may invalidate a lodgement" },
    ] as const;
    for (const attempt of attempts) {
      expect(evaluateLockChange({ ...attempt, role: "OWNER", actorType: "AUTOMATION" }).ok).toBe(false);
      expect(evaluateLockChange({ ...attempt, role: "OWNER", actorType: "HUMAN" }).ok).toBe(true);
    }
  });

  it("webhook, integration and automation management guards", () => {
    for (const actor of [bareOwner, automation]) {
      expect(() => assertHumanWebhookManager(actor)).toThrow(PermissionDeniedError);
      expect(() => assertHumanIntegrationManager(actor)).toThrow(PermissionDeniedError);
      expect(() => assertHumanAutomationManager(actor)).toThrow(PermissionDeniedError);
    }
    const person: Actor = { userId: "u1", organizationId: "o1", role: "OWNER" };
    expect(() => assertHumanWebhookManager(person)).not.toThrow();
    expect(() => assertHumanIntegrationManager(person)).not.toThrow();
    expect(() => assertHumanAutomationManager(person)).not.toThrow();
  });

  it("the other non-human types are refused the same way (API, AI, SYSTEM)", () => {
    for (const type of ["API", "AI", "SYSTEM"] as const) {
      const actor: Actor = { userId: "u1", organizationId: "o1", role: "OWNER", type };
      expect(() => assertHumanAutomationManager(actor)).toThrow(PermissionDeniedError);
      expect(() => assertHumanIntegrationManager(actor)).toThrow(PermissionDeniedError);
    }
  });
});

describe("execution identity: it can only shrink", () => {
  it("only OWNER and ADMINISTRATOR may authorise a rule; everyone else is refused with a visible reason", () => {
    for (const role of ROLES_BY_PRIVILEGE) {
      const result = resolveExecutionIdentity(rule("invoice.created", "NOTIFY_IN_APP"), state(role));
      expect(result.ok, role).toBe(role === "OWNER" || role === "ADMINISTRATOR");
      if (!result.ok) {
        expect(result.code).toBe("AUTHORISER_LACKS_PERMISSION");
        expect(result.reason).toMatch(/^Rule disabled:/);
      }
    }
  });

  it("a removed, inactive or suspended authoriser yields AUTHORISER_INACTIVE", () => {
    const base = rule("invoice.created", "NOTIFY_IN_APP");
    expect(resolveExecutionIdentity(base, undefined)).toMatchObject({ ok: false, code: "AUTHORISER_INACTIVE" });
    expect(resolveExecutionIdentity(base, state(null))).toMatchObject({ ok: false, code: "AUTHORISER_INACTIVE" });
    expect(resolveExecutionIdentity(base, state("OWNER", { membershipActive: false }))).toMatchObject({ ok: false, code: "AUTHORISER_INACTIVE" });
    expect(resolveExecutionIdentity(base, state("OWNER", { userDisabledAt: new Date() }))).toMatchObject({ ok: false, code: "AUTHORISER_INACTIVE" });
    expect(resolveExecutionIdentity(base, state("OWNER", { membershipActive: null }))).toMatchObject({ ok: false, code: "AUTHORISER_INACTIVE" });
  });

  it("the grant is always a subset of (required ∩ the person's current role ∩ allow-list)", () => {
    for (const role of ["OWNER", "ADMINISTRATOR"] as const) {
      for (const trigger of TRIGGERS) {
        for (const action of ACTION_TYPES) {
          const result = resolveExecutionIdentity(rule(trigger, action), state(role));
          if (!result.ok) continue;
          const required = new Set(requiredPermissions(trigger, action));
          for (const p of result.granted) {
            expect(required.has(p)).toBe(true);
            expect(roleHasPermission(role, p)).toBe(true);
            expect(AUTOMATION_ALLOWED_PERMISSIONS.has(p)).toBe(true);
          }
          expect(result.granted.size).toBeLessThan(ROLE_PERMISSIONS[role].size / 10); // nowhere near OWNER's power
        }
      }
    }
  });

  it("a role that loses the permission the action needs is refused naming it (re-evaluated at every run)", () => {
    // Simulate a future role matrix change by asking for an action whose permission the role lacks.
    const result = resolveExecutionIdentity(rule("INVENTORY_BELOW_REORDER", "CREATE_DRAFT_PURCHASE_ORDER"), state("ACCOUNTANT"));
    expect(result.ok).toBe(false);
  });

  it("automation:manage and integration:manage are held only by OWNER and ADMINISTRATOR; automation:read by the intended viewing roles", () => {
    for (const role of ROLES_BY_PRIVILEGE) {
      const manage = role === "OWNER" || role === "ADMINISTRATOR";
      expect(roleHasPermission(role, "automation:manage"), role).toBe(manage);
      expect(roleHasPermission(role, "integration:manage"), role).toBe(manage);
    }
    for (const role of ["ACCOUNTANT", "BOOKKEEPER", "MANAGER", "READ_ONLY", "OWNER", "ADMINISTRATOR"] as const) expect(roleHasPermission(role, "automation:read"), role).toBe(true);
    for (const role of ["EMPLOYEE", "ACCOUNTS_RECEIVABLE", "ACCOUNTS_PAYABLE", "PAYROLL_MANAGER"] as const) expect(roleHasPermission(role, "automation:read"), role).toBe(false);
  });
});
