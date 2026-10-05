"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import {
  AlreadyMemberError,
  LastOwnerError,
  OrganizationService,
  SeatLimitReachedError,
  UserNotFoundError,
  WriteAccessConfirmationRequiredError,
} from "@/domain/organizations/organization-service";
import { membershipRoleEnum } from "@/db/schema";
import { AutonomySettingsService, InvalidAutonomyLevelError } from "@/domain/ai-controller/autonomy";
import { AutoApprovedActionsService, InvalidAutoApprovedActionTypeError } from "@/domain/ai-controller/auto-execution-policy";
import { AutoExecutionService } from "@/domain/ai-controller/auto-execution-service";

const roleValues = membershipRoleEnum.enumValues;

/**
 * Plain `<form action>`s can't render a returned error, so a refusal the user
 * can act on (seat limit reached, unknown email, last owner) is surfaced via
 * a `memberError` query param the settings page renders as a banner.
 */
const MEMBER_ERRORS = [
  SeatLimitReachedError,
  UserNotFoundError,
  AlreadyMemberError,
  LastOwnerError,
  WriteAccessConfirmationRequiredError,
];

function memberErrorMessage(error: unknown): string | null {
  return MEMBER_ERRORS.some((E) => error instanceof E) ? (error as Error).message : null;
}

function failWith(orgSlug: string, message: string): never {
  redirect(`/${orgSlug}/settings?memberError=${encodeURIComponent(message)}`);
}

const InviteSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(roleValues as [string, ...string[]]),
});

export async function inviteMemberAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);

  const parsed = InviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) return;

  try {
    await OrganizationService.addMemberByEmail(
      actor,
      parsed.data.email,
      parsed.data.role as (typeof roleValues)[number],
      // Always passed on this path, so the server enforces the write-access confirmation.
      { confirmWriteAccess: formData.get("confirmWriteAccess") === "true" },
    );
  } catch (error) {
    const message = memberErrorMessage(error);
    if (message) failWith(orgSlug, message);
    throw error;
  }
  revalidatePath(`/${orgSlug}/settings`);
}

export async function updateMemberRoleAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);

  const membershipId = formData.get("membershipId");
  const role = formData.get("role");
  if (typeof membershipId !== "string" || typeof role !== "string") return;
  if (!roleValues.includes(role as (typeof roleValues)[number])) return;

  try {
    await OrganizationService.updateMemberRole(actor, membershipId, role as (typeof roleValues)[number], {
      confirmWriteAccess: formData.get("confirmWriteAccess") === "true",
    });
  } catch (error) {
    const message = memberErrorMessage(error);
    if (message) failWith(orgSlug, message);
    throw error;
  }
  revalidatePath(`/${orgSlug}/settings`);
}

export async function removeMemberAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);

  const membershipId = formData.get("membershipId");
  if (typeof membershipId !== "string") return;

  try {
    await OrganizationService.removeMember(actor, membershipId);
  } catch (error) {
    const message = memberErrorMessage(error);
    if (message) failWith(orgSlug, message);
    throw error;
  }
  revalidatePath(`/${orgSlug}/settings`);
}

/**
 * Master spec §8's autonomy level — OWNER/ADMINISTRATOR only
 * (`AutonomySettingsService.setLevel` itself enforces `organization:manage`,
 * this is just the form entry point). Levels 3/4 are rejected with an
 * honest reason rather than silently accepted — see
 * `src/domain/ai-controller/autonomy.ts`. A plain `<form action>` (like
 * every other setting on this page) can't render a returned error, so an
 * invalid submission (which the UI's own radio buttons never produce) is
 * simply ignored rather than thrown as an uncaught 500 — `InvalidAutonomyLevelError`
 * and a permission refusal are both swallowed here for that reason.
 */
export async function updateAutonomyLevelAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const raw = formData.get("autonomyLevel");
  const level = Number(raw);
  if (!Number.isInteger(level)) return;

  try {
    await AutonomySettingsService.setLevel(actor, level);
  } catch (err) {
    if (err instanceof InvalidAutonomyLevelError) return;
    throw err;
  }
  revalidatePath(`/${orgSlug}/settings`);
}

/**
 * A real, reachable control separate from the level picker above (master
 * spec §77's "pause/override") — see `AutonomySettingsService.emergencyStop`.
 * Swallows a permission refusal the same way the level-picker form does:
 * this page only ever renders the button for an actor who already holds
 * `organization:manage`, so a submission from anyone else can only be a
 * stale/forged request, not a real user hitting an error they need to see.
 */
export async function emergencyStopAction(orgSlug: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  try {
    await AutonomySettingsService.emergencyStop(actor);
  } catch {
    return;
  }
  revalidatePath(`/${orgSlug}/settings`);
}

/**
 * The Level 3/4 whitelist (master spec §76) — one checkbox per auto-
 * approvable action type. `AutoApprovedActionsService.setEnabled` itself
 * re-validates `actionType` against the closed enum regardless of what this
 * form's own checkboxes could produce, so a tampered/forged submission is
 * refused structurally, not just prevented by the UI.
 */
export async function updateAutoApprovedActionAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const actionType = formData.get("actionType");
  const enabled = formData.get("enabled") === "true";
  if (typeof actionType !== "string") return;

  try {
    await AutoApprovedActionsService.setEnabled(actor, actionType, enabled);
  } catch (err) {
    if (err instanceof InvalidAutoApprovedActionTypeError) return;
    throw err;
  }
  revalidatePath(`/${orgSlug}/settings`);
}

/**
 * The on-demand touchpoint for Level 3/4 auto-execution (see
 * `auto-execution-service.ts`'s doc comment on why this codebase has no
 * background job queue to run it automatically). Safe to click at any
 * autonomy level — it only ever does anything for an action type that is
 * BOTH Level 3/4 AND explicitly whitelisted.
 */
export async function runAutoExecutionsAction(orgSlug: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await AutoExecutionService.runPendingAutoExecutions(actor);
  revalidatePath(`/${orgSlug}/settings`);
}
