import type { Actor } from "@/domain/permissions/permission-service";
import { ROLE_PERMISSIONS, roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";
import { ACTION_PERMISSIONS, AUTOMATION_ALLOWED_PERMISSIONS, TRIGGER_READ_PERMISSIONS, isForbiddenForAutomation, type ActionType, type Trigger } from "./vocabulary";

/**
 * The EXECUTION IDENTITY of an automation (docs/security.md section 18).
 *
 * An automation is an action without a human click, so it runs as a distinct NON-human actor type, `AUTOMATION`. Every
 * human-only check in the codebase (`assertHumanWith`, `evaluatePosting`, `evaluateLockChange`, the webhook / API-key /
 * invite / archive guards) asks "is this actor a HUMAN?" and therefore refuses it - even when the person who authorised
 * the rule is an OWNER.
 *
 * Its permissions are computed afresh on EVERY run as
 *
 *      (the permissions the rule's action + trigger need)  ∩  (the authorising person's CURRENT role)  ∩  (the short allow-list)
 *
 * so the identity can only ever be SMALLER than the person's current power, never larger, and a demoted, suspended or
 * removed person shrinks or stops the rule immediately. `automation:manage` is also required of that person at run time:
 * a rule authorised by someone who can no longer manage automations does not run.
 */

export interface AuthoriserState {
  userId: string;
  /** The person's role in THIS organization right now, or null when they have no membership. */
  role: MembershipRole | null;
  membershipActive: boolean | null;
  userDisabledAt: Date | null;
}

export type IdentityCode = "AUTHORISER_INACTIVE" | "AUTHORISER_LACKS_PERMISSION";

export type IdentityResult =
  | { ok: true; actor: Actor; granted: ReadonlySet<Permission> }
  | { ok: false; code: IdentityCode; reason: string };

/** Everything a rule needs from its authoriser: the action's permissions plus the read permission for the trigger's object. */
export function requiredPermissions(trigger: Trigger, action: ActionType): Permission[] {
  return [...new Set<Permission>([...ACTION_PERMISSIONS[action], TRIGGER_READ_PERMISSIONS[trigger]])];
}

export function resolveExecutionIdentity(
  rule: { id: string; name: string; organizationId: string; trigger: Trigger; actionType: ActionType },
  authoriser: AuthoriserState | undefined,
): IdentityResult {
  if (!authoriser || !authoriser.role || !authoriser.membershipActive || authoriser.userDisabledAt) {
    return { ok: false, code: "AUTHORISER_INACTIVE", reason: "Rule disabled: the person who authorised it is no longer an active member of this organization." };
  }
  if (!roleHasPermission(authoriser.role, "automation:manage")) {
    return { ok: false, code: "AUTHORISER_LACKS_PERMISSION", reason: "Rule disabled: the person who authorised it no longer has a role that can manage automations." };
  }
  const required = requiredPermissions(rule.trigger, rule.actionType);
  const rolePermissions = ROLE_PERMISSIONS[authoriser.role];
  const missing = required.filter((p) => !rolePermissions.has(p));
  if (missing.length > 0) {
    return { ok: false, code: "AUTHORISER_LACKS_PERMISSION", reason: `Rule disabled: the person who authorised it no longer has permission to ${missing[0]!.replace(":", " ")}.` };
  }
  // required ∩ role ∩ allow-list, minus anything forbidden by name. Each factor can only remove power.
  const granted = new Set<Permission>(required.filter((p) => rolePermissions.has(p) && AUTOMATION_ALLOWED_PERMISSIONS.has(p) && !isForbiddenForAutomation(p)));
  const actor: Actor = {
    userId: authoriser.userId,
    organizationId: rule.organizationId,
    role: authoriser.role,
    type: "AUTOMATION",
    grantedPermissions: granted,
    automation: { ruleId: rule.id, ruleName: rule.name },
  };
  return { ok: true, actor, granted };
}
