import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";

/**
 * Creating, editing, enabling, deleting a rule, the "pause all" switch and "Run automations now" all need
 * `automation:manage` (OWNER / ADMINISTRATOR) AND a HUMAN actor. Creating or enabling a rule is the person's explicit
 * approval of that narrow action (master spec s.76), so an API key, an AI agent, the system or an automation itself can
 * never do it - even with an OWNER role behind it.
 */
export function assertHumanAutomationManager(actor: Actor): void {
  assertPermission(actor, "automation:manage");
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError("automation:manage", actor.role);
}
