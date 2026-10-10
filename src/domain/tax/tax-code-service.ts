import { and, eq } from "drizzle-orm";
import { taxCodes } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import type { BasGstTreatment } from "./bas-calculations";

export interface CreateTaxCodeInput {
  code: string;
  name: string;
  /** Decimal string, e.g. "0.1000" for 10%. */
  rate: string;
  jurisdiction: string;
  effectiveFrom: Date;
  effectiveTo?: Date;
  /** The liability account tax collected under this code is credited to — see src/domain/sales/invoice-service.ts. */
  payableAccountId?: string;
  /** The asset account tax paid under this code is debited to (input tax credit) — see src/domain/purchases/bill-service.ts. */
  receivableAccountId?: string;
  /** Phase 8 Slice 2: BAS treatment. Omit to leave the code UNCLASSIFIED (the BAS prep never guesses). */
  basTreatment?: BasGstTreatment;
  /** Phase 8 Slice 2: purchases under this code are capital purchases (G10) rather than non-capital (G11). */
  basCapital?: boolean;
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
          payableAccountId: input.payableAccountId ?? null,
          receivableAccountId: input.receivableAccountId ?? null,
          basTreatment: input.basTreatment ?? null,
          basCapital: input.basCapital ?? false,
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

  /**
   * Sets how a tax code is treated for the BAS (Phase 8 Slice 2). This changes how DRAFT BAS statements classify
   * the code's lines from now on; a FINALISED BAS is an immutable snapshot and is not affected. Audited.
   */
  async setBasClassification(
    actor: Actor,
    taxCodeId: string,
    input: { basTreatment: BasGstTreatment | null; basCapital: boolean },
  ) {
    assertPermission(actor, "tax_code:manage");
    if (input.basCapital && input.basTreatment !== "TAXABLE") {
      throw new Error("Only a TAXABLE tax code can be marked as a capital purchase code.");
    }
    return withTenant(actor.organizationId, async (tx) => {
      const [before] = await tx
        .select()
        .from(taxCodes)
        .where(and(eq(taxCodes.id, taxCodeId), eq(taxCodes.organizationId, actor.organizationId)));
      if (!before) throw new Error("Tax code not found.");
      const [after] = await tx
        .update(taxCodes)
        .set({ basTreatment: input.basTreatment, basCapital: input.basCapital, updatedAt: new Date() })
        .where(eq(taxCodes.id, taxCodeId))
        .returning();
      await AuditService.record(tx, actor, {
        action: "tax_code.bas_classification_changed",
        entityType: "TaxCode",
        entityId: taxCodeId,
        before: { basTreatment: before.basTreatment, basCapital: before.basCapital },
        after: { basTreatment: input.basTreatment, basCapital: input.basCapital },
      });
      return after!;
    });
  },
};
