"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireGroupUser } from "./require-user";
import { GroupService } from "@/domain/consolidation/group-service";
import { AdjustmentService } from "@/domain/consolidation/adjustment-service";
import type { GroupRole, IntercompanyKind } from "@/domain/consolidation/types";
import type { AccountType } from "@/domain/accounts/account-service";

function back(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

export async function createGroupAction(formData: FormData): Promise<void> {
  const { actor } = await requireGroupUser();
  let group;
  try {
    group = await GroupService.create(actor, { name: str(formData, "name"), description: str(formData, "description") || undefined });
  } catch (error) {
    back("/app/groups", error);
  }
  revalidatePath("/app/groups");
  redirect(`/app/groups/${group.id}`);
}

export async function archiveGroupAction(groupId: string): Promise<void> {
  const { actor } = await requireGroupUser();
  try {
    await GroupService.archive(actor, groupId);
  } catch (error) {
    back(`/app/groups/${groupId}`, error);
  }
  revalidatePath("/app/groups");
  redirect("/app/groups");
}

export async function addEntityAction(groupId: string, formData: FormData): Promise<void> {
  const { actor } = await requireGroupUser();
  const path = `/app/groups/${groupId}`;
  try {
    const role = str(formData, "role");
    await GroupService.addEntity(actor, groupId, str(formData, "organizationId"), role ? (role as GroupRole) : undefined);
  } catch (error) {
    back(path, error);
  }
  revalidatePath(path);
  redirect(path);
}

export async function removeEntityAction(groupId: string, organizationId: string): Promise<void> {
  const { actor } = await requireGroupUser();
  const path = `/app/groups/${groupId}`;
  try {
    await GroupService.removeEntity(actor, groupId, organizationId);
  } catch (error) {
    back(path, error);
  }
  revalidatePath(path);
  redirect(path);
}

export async function setIncludedAction(groupId: string, organizationId: string, included: boolean): Promise<void> {
  const { actor } = await requireGroupUser();
  const path = `/app/groups/${groupId}`;
  try {
    await GroupService.setEntityIncluded(actor, groupId, organizationId, included);
  } catch (error) {
    back(path, error);
  }
  revalidatePath(path);
  redirect(path);
}

export async function setRoleAction(groupId: string, organizationId: string, formData: FormData): Promise<void> {
  const { actor } = await requireGroupUser();
  const path = `/app/groups/${groupId}`;
  try {
    await GroupService.setEntityRole(actor, groupId, organizationId, str(formData, "role") as GroupRole);
  } catch (error) {
    back(path, error);
  }
  revalidatePath(path);
  redirect(path);
}

export async function addGroupAccountAction(groupId: string, formData: FormData): Promise<void> {
  const { actor } = await requireGroupUser();
  const path = `/app/groups/${groupId}/setup`;
  try {
    await GroupService.addGroupAccount(actor, groupId, {
      type: str(formData, "type") as AccountType,
      code: str(formData, "code"),
      name: str(formData, "name"),
    });
  } catch (error) {
    back(path, error);
  }
  revalidatePath(path);
  redirect(path);
}

export async function removeGroupAccountAction(groupId: string, groupAccountId: string): Promise<void> {
  const { actor } = await requireGroupUser();
  const path = `/app/groups/${groupId}/setup`;
  try {
    await GroupService.removeGroupAccount(actor, groupId, groupAccountId);
  } catch (error) {
    back(path, error);
  }
  revalidatePath(path);
  redirect(path);
}

export async function mapAccountAction(groupId: string, organizationId: string, accountId: string, formData: FormData): Promise<void> {
  const { actor } = await requireGroupUser();
  const path = `/app/groups/${groupId}/setup`;
  try {
    const target = str(formData, "groupAccountId");
    if (target) await GroupService.mapAccount(actor, groupId, organizationId, accountId, target);
    else await GroupService.unmapAccount(actor, groupId, organizationId, accountId);
  } catch (error) {
    back(path, error);
  }
  revalidatePath(path);
  redirect(path);
}

export async function designateIntercompanyAction(groupId: string, organizationId: string, accountId: string, formData: FormData): Promise<void> {
  const { actor } = await requireGroupUser();
  const path = `/app/groups/${groupId}/setup`;
  try {
    const kind = str(formData, "kind");
    const counterparty = str(formData, "counterpartyOrganizationId");
    if (kind && counterparty) {
      await GroupService.designateIntercompany(actor, groupId, {
        organizationId,
        accountId,
        kind: kind as IntercompanyKind,
        counterpartyOrganizationId: counterparty,
      });
    } else {
      await GroupService.removeIntercompany(actor, groupId, organizationId, accountId);
    }
  } catch (error) {
    back(path, error);
  }
  revalidatePath(path);
  redirect(path);
}

export async function createAdjustmentAction(groupId: string, formData: FormData): Promise<void> {
  const { actor } = await requireGroupUser();
  const path = `/app/groups/${groupId}/adjustments`;
  try {
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const groupAccountId = str(formData, `account-${i}`);
      const debit = str(formData, `debit-${i}`);
      const credit = str(formData, `credit-${i}`);
      if (!groupAccountId && !debit && !credit) continue;
      lines.push({ groupAccountId, debit: debit || undefined, credit: credit || undefined, memo: str(formData, `memo-${i}`) || undefined });
    }
    await AdjustmentService.create(actor, groupId, {
      kind: str(formData, "kind") === "ELIMINATION" ? "ELIMINATION" : "ADJUSTMENT",
      effectiveDate: new Date(str(formData, "effectiveDate")),
      description: str(formData, "description"),
      reason: str(formData, "reason"),
      lines,
    });
  } catch (error) {
    back(path, error);
  }
  revalidatePath(path);
  redirect(path);
}

export async function reverseAdjustmentAction(groupId: string, adjustmentId: string, formData: FormData): Promise<void> {
  const { actor } = await requireGroupUser();
  const path = `/app/groups/${groupId}/adjustments`;
  try {
    await AdjustmentService.reverse(actor, groupId, adjustmentId, { reason: str(formData, "reason") });
  } catch (error) {
    back(path, error);
  }
  revalidatePath(path);
  redirect(path);
}
