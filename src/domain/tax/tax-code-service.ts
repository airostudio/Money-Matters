import { and, eq } from "drizzle-orm";
import { taxCodes } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";

export interface CreateTaxCodeInput {
  code: string;
  name: string;
  /** Decimal string, e.g. "0.1000" for 10%. */
  rate: string;
  jurisdiction: string;
  effectiveFrom: Date;
  effectiveTo?: Date;
}

/**
 * Tax rules are versioned by effective date, never hard-coded — see
 * docs/database.md §2 and master spec §26/§88. Phase 1 only stores and
 * serves tax codes; BAS/return preparation is Phase 8.
 */
export const TaxCodeService = {
  async list(actor: Actor, opts: { includeInactive?: boolean } = {}) {
    assertPermission(actor, "journal:read");
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(taxCodes)
        .where(
          opts.includeInactive
            ? eq(taxCodes.organizationId, actor.organizationId)
            : and(eq(taxCodes.organizationId, actor.organizationId), eq(taxCodes.isActive, true)),
        ),
    );
  },

  async create(actor: Actor, input: CreateTaxCodeInput) {
    assertPermission(actor, "tax_code:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [taxCode] = await tx
        .insert(taxCodes)
        .values({
          organizationId: actor.organizationId,
          code: input.code,
          name: input.name,
          rate: input.rate,
          jurisdiction: input.jurisdiction,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
        })
        .returning();
      if (!taxCode) throw new Error("Failed to create tax code.");

      await AuditService.record(tx, actor, {
        action: "tax_code.created",
        entityType: "TaxCode",
        entityId: taxCode.id,
        after: taxCode,
      });

      return taxCode;
    });
  },
};
