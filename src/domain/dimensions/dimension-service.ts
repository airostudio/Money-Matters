import { and, asc, eq } from "drizzle-orm";
import { dimensionValues, dimensions } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";

/**
 * CRUD for the "Universal Dimension Engine" (master spec §4/§33) —
 * `dimensions`/`dimension_values` have existed in the schema since Phase 1,
 * and `PostingService` has always been able to attach `dimensionValueIds` to
 * a journal line, but until Phase 5 Slice 2 nothing in the app could create
 * a Dimension or a DimensionValue at all, and no UI ever passed
 * `dimensionValueIds` through. This is the minimal, production-quality
 * admin surface that closes that gap for the simplest, lowest-risk entry
 * point — manual journal entries (`/[orgSlug]/accounting/journals/new`) —
 * so dimensional reporting has real data to filter by. Attaching a
 * dimension to an individual invoice/bill line (Phase 3/4's own posting
 * paths) is a materially larger change across those services' line editors
 * and is explicitly deferred to Slice 3 — see docs/roadmap.md.
 */

export class DimensionNotFoundError extends Error {
  constructor(dimensionId: string) {
    super(`Dimension ${dimensionId} was not found in this organization.`);
    this.name = "DimensionNotFoundError";
  }
}

export class DuplicateDimensionKeyError extends Error {
  constructor(key: string) {
    super(`A dimension with key "${key}" already exists in this organization.`);
    this.name = "DuplicateDimensionKeyError";
  }
}

export class DuplicateDimensionValueError extends Error {
  constructor(value: string) {
    super(`A value "${value}" already exists for this dimension.`);
    this.name = "DuplicateDimensionValueError";
  }
}

export class InvalidDimensionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDimensionInputError";
  }
}

function slugifyKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function loadDimensionOr404(tx: TenantDb, organizationId: string, dimensionId: string) {
  const [dimension] = await tx
    .select()
    .from(dimensions)
    .where(and(eq(dimensions.id, dimensionId), eq(dimensions.organizationId, organizationId)));
  if (!dimension) throw new DimensionNotFoundError(dimensionId);
  return dimension;
}

export interface DimensionWithValues {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
  values: { id: string; value: string; label: string; isActive: boolean }[];
}

export const DimensionService = {
  /** Every dimension in the org with its values. */
  async list(actor: Actor): Promise<DimensionWithValues[]> {
    assertPermission(actor, "dimension:read");
    return withTenant(actor.organizationId, async (tx) => {
      const dimensionRows = await tx
        .select()
        .from(dimensions)
        .where(eq(dimensions.organizationId, actor.organizationId))
        .orderBy(asc(dimensions.name));

      const valueRows = await tx
        .select()
        .from(dimensionValues)
        .where(eq(dimensionValues.organizationId, actor.organizationId))
        .orderBy(asc(dimensionValues.label));

      const valuesByDimension = new Map<string, DimensionWithValues["values"]>();
      for (const v of valueRows) {
        const list = valuesByDimension.get(v.dimensionId) ?? [];
        list.push({ id: v.id, value: v.value, label: v.label, isActive: v.isActive });
        valuesByDimension.set(v.dimensionId, list);
      }

      return dimensionRows.map((d) => ({
        id: d.id,
        key: d.key,
        name: d.name,
        isActive: d.isActive,
        values: valuesByDimension.get(d.id) ?? [],
      }));
    });
  },

  /** Same as `list`, but only active dimensions/values — for pickers (the journal line editor, report builder, NL reporting). */
  async listActive(actor: Actor): Promise<DimensionWithValues[]> {
    const all = await this.list(actor);
    return all
      .filter((d) => d.isActive)
      .map((d) => ({ ...d, values: d.values.filter((v) => v.isActive) }));
  },

  async createDimension(actor: Actor, input: { name: string }): Promise<DimensionWithValues> {
    assertPermission(actor, "dimension:manage");
    const name = input.name.trim();
    if (!name) throw new InvalidDimensionInputError("A dimension needs a name.");
    const key = slugifyKey(name);
    if (!key) throw new InvalidDimensionInputError("A dimension name must contain at least one letter or digit.");

    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select({ id: dimensions.id })
        .from(dimensions)
        .where(and(eq(dimensions.organizationId, actor.organizationId), eq(dimensions.key, key)));
      if (existing) throw new DuplicateDimensionKeyError(key);

      const [created] = await tx
        .insert(dimensions)
        .values({ organizationId: actor.organizationId, key, name })
        .returning();
      if (!created) throw new Error("Failed to create dimension.");

      await AuditService.record(tx, actor, {
        entityType: "DIMENSION",
        entityId: created.id,
        action: "CREATED",
        after: created,
      });

      return { id: created.id, key: created.key, name: created.name, isActive: created.isActive, values: [] };
    });
  },

  async setDimensionActive(actor: Actor, dimensionId: string, isActive: boolean): Promise<void> {
    assertPermission(actor, "dimension:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const before = await loadDimensionOr404(tx, actor.organizationId, dimensionId);
      const [after] = await tx
        .update(dimensions)
        .set({ isActive, updatedAt: new Date() })
        .where(and(eq(dimensions.id, dimensionId), eq(dimensions.organizationId, actor.organizationId)))
        .returning();

      await AuditService.record(tx, actor, {
        entityType: "DIMENSION",
        entityId: dimensionId,
        action: isActive ? "ACTIVATED" : "DEACTIVATED",
        before,
        after,
      });
    });
  },

  async addValue(actor: Actor, dimensionId: string, input: { label: string }): Promise<{ id: string; value: string; label: string; isActive: boolean }> {
    assertPermission(actor, "dimension:manage");
    const label = input.label.trim();
    if (!label) throw new InvalidDimensionInputError("A dimension value needs a label.");
    const value = slugifyKey(label);
    if (!value) throw new InvalidDimensionInputError("A dimension value must contain at least one letter or digit.");

    return withTenant(actor.organizationId, async (tx) => {
      await loadDimensionOr404(tx, actor.organizationId, dimensionId);

      const [existing] = await tx
        .select({ id: dimensionValues.id })
        .from(dimensionValues)
        .where(and(eq(dimensionValues.dimensionId, dimensionId), eq(dimensionValues.value, value)));
      if (existing) throw new DuplicateDimensionValueError(value);

      const [created] = await tx
        .insert(dimensionValues)
        .values({ organizationId: actor.organizationId, dimensionId, value, label })
        .returning();
      if (!created) throw new Error("Failed to create dimension value.");

      await AuditService.record(tx, actor, {
        entityType: "DIMENSION_VALUE",
        entityId: created.id,
        action: "CREATED",
        after: created,
      });

      return { id: created.id, value: created.value, label: created.label, isActive: created.isActive };
    });
  },

  async setValueActive(actor: Actor, dimensionValueId: string, isActive: boolean): Promise<void> {
    assertPermission(actor, "dimension:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const [before] = await tx
        .select()
        .from(dimensionValues)
        .where(and(eq(dimensionValues.id, dimensionValueId), eq(dimensionValues.organizationId, actor.organizationId)));
      if (!before) throw new Error(`Dimension value ${dimensionValueId} was not found in this organization.`);

      const [after] = await tx
        .update(dimensionValues)
        .set({ isActive, updatedAt: new Date() })
        .where(and(eq(dimensionValues.id, dimensionValueId), eq(dimensionValues.organizationId, actor.organizationId)))
        .returning();

      await AuditService.record(tx, actor, {
        entityType: "DIMENSION_VALUE",
        entityId: dimensionValueId,
        action: isActive ? "ACTIVATED" : "DEACTIVATED",
        before,
        after,
      });
    });
  },

  /** Confirms `dimensionValueId` belongs to the actor's organization and returns it with its parent dimension's key — used by report-builder/NL-reporting to validate a dimension filter before querying. */
  async getValueWithDimension(
    actor: Actor,
    dimensionValueId: string,
  ): Promise<{ id: string; value: string; label: string; dimensionId: string; dimensionKey: string; dimensionName: string } | null> {
    assertPermission(actor, "dimension:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({
          id: dimensionValues.id,
          value: dimensionValues.value,
          label: dimensionValues.label,
          dimensionId: dimensionValues.dimensionId,
          dimensionKey: dimensions.key,
          dimensionName: dimensions.name,
        })
        .from(dimensionValues)
        .innerJoin(dimensions, eq(dimensions.id, dimensionValues.dimensionId))
        .where(and(eq(dimensionValues.id, dimensionValueId), eq(dimensionValues.organizationId, actor.organizationId)));
      return row ?? null;
    });
  },
};
