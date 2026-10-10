import { and, asc, eq } from "drizzle-orm";
import { fixedAssetClasses } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { FixedAssetClassNotFoundError, InvalidFixedAssetClassError } from "./errors";
import type { CreateFixedAssetClassInput, UpdateFixedAssetClassInput } from "./types";

export async function loadAssetClassOr404(tx: TenantDb, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(fixedAssetClasses)
    .where(and(eq(fixedAssetClasses.id, id), eq(fixedAssetClasses.organizationId, organizationId)));
  if (!row) throw new FixedAssetClassNotFoundError(id);
  return row;
}

function validate(input: CreateFixedAssetClassInput) {
  if (!input.name.trim()) throw new InvalidFixedAssetClassError("A name is required.");
  if (!Number.isInteger(input.defaultUsefulLifeMonths) || input.defaultUsefulLifeMonths <= 0) {
    throw new InvalidFixedAssetClassError("Default useful life must be a positive whole number of months.");
  }
}

/**
 * A simple per-org lookup/template for a category of fixed asset — see
 * `fixedAssetClasses`' doc comment in src/db/schema.ts. Deliberately no
 * depreciation-policy engine: just a name, a default method, and a default
 * useful life, both overridable per-asset at registration time.
 */
export const FixedAssetClassService = {
  async list(actor: Actor, opts: { isActive?: boolean } = {}) {
    assertPermission(actor, "fixed_asset:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(fixedAssetClasses.organizationId, actor.organizationId)];
      if (opts.isActive !== undefined) conditions.push(eq(fixedAssetClasses.isActive, opts.isActive));
      return tx
        .select()
        .from(fixedAssetClasses)
        .where(and(...conditions))
        .orderBy(asc(fixedAssetClasses.name));
    });
  },

  async get(actor: Actor, id: string) {
    assertPermission(actor, "fixed_asset:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(fixedAssetClasses)
        .where(and(eq(fixedAssetClasses.id, id), eq(fixedAssetClasses.organizationId, actor.organizationId)));
      return row ?? null;
    });
  },

  async create(actor: Actor, input: CreateFixedAssetClassInput) {
    assertPermission(actor, "fixed_asset:manage");
    validate(input);
    return withTenant(actor.organizationId, async (tx) => {
      const [created] = await tx
        .insert(fixedAssetClasses)
        .values({
          organizationId: actor.organizationId,
          name: input.name.trim(),
          defaultDepreciationMethod: input.defaultDepreciationMethod ?? "STRAIGHT_LINE",
          defaultUsefulLifeMonths: input.defaultUsefulLifeMonths,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create fixed asset class.");

      await AuditService.record(tx, actor, {
        action: "fixed_asset_class.created",
        entityType: "FixedAssetClass",
        entityId: created.id,
        after: { name: created.name, defaultUsefulLifeMonths: created.defaultUsefulLifeMonths },
      });

      return created;
    });
  },

  async update(actor: Actor, id: string, input: UpdateFixedAssetClassInput) {
    assertPermission(actor, "fixed_asset:manage");
    validate(input);
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadAssetClassOr404(tx, actor.organizationId, id);

      const [updated] = await tx
        .update(fixedAssetClasses)
        .set({
          name: input.name.trim(),
          defaultDepreciationMethod: input.defaultDepreciationMethod ?? "STRAIGHT_LINE",
          defaultUsefulLifeMonths: input.defaultUsefulLifeMonths,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(fixedAssetClasses.id, id))
        .returning();

      await AuditService.record(tx, actor, {
        action: "fixed_asset_class.updated",
        entityType: "FixedAssetClass",
        entityId: id,
        before: { name: existing.name, defaultUsefulLifeMonths: existing.defaultUsefulLifeMonths },
        after: { name: input.name, defaultUsefulLifeMonths: input.defaultUsefulLifeMonths },
      });

      return updated;
    });
  },

  async setActive(actor: Actor, id: string, isActive: boolean) {
    assertPermission(actor, "fixed_asset:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadAssetClassOr404(tx, actor.organizationId, id);
      const [updated] = await tx
        .update(fixedAssetClasses)
        .set({ isActive, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(fixedAssetClasses.id, id))
        .returning();

      await AuditService.record(tx, actor, {
        action: isActive ? "fixed_asset_class.reactivated" : "fixed_asset_class.deactivated",
        entityType: "FixedAssetClass",
        entityId: id,
        before: { isActive: existing.isActive },
        after: { isActive },
      });

      return updated;
    });
  },
};
