import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { accounts, contacts, products, type productTypeEnum } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import {
  InvalidProductError,
  MissingProductAccountsError,
  ProductNotFoundError,
  ProductSkuInUseError,
} from "./errors";
import type { CreateProductInput, UpdateProductInput } from "./types";

type ProductType = (typeof productTypeEnum.enumValues)[number];

async function assertAccountsUsable(tx: TenantDb, organizationId: string, accountIds: string[]) {
  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.length === 0) return;
  const rows = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, uniqueIds)));
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of uniqueIds) {
    const row = found.get(id);
    if (!row) throw new InvalidProductError(`Account ${id} does not exist in this organization.`);
    if (!row.isActive) throw new InvalidProductError(`Account ${id} is inactive.`);
  }
}

/**
 * Validates the account wiring required for `type` — see `products`' doc
 * comment in src/db/schema.ts for exactly which accounts each type needs.
 * Returns the normalized {purchaseAccountId, inventoryAssetAccountId,
 * cogsAccountId} to persist, nulling out whichever fields don't apply to
 * `type` so a caller can't leave stale accounts from a prior type on the row.
 */
function resolveTypeAccounts(input: CreateProductInput) {
  if (input.type === "TRACKED_INVENTORY") {
    if (!input.inventoryAssetAccountId || !input.cogsAccountId) {
      throw new MissingProductAccountsError(
        "A TRACKED_INVENTORY product requires both an inventory asset account and a COGS account.",
      );
    }
    return {
      purchaseAccountId: null,
      inventoryAssetAccountId: input.inventoryAssetAccountId,
      cogsAccountId: input.cogsAccountId,
    };
  }

  if (!input.purchaseAccountId) {
    throw new MissingProductAccountsError(
      "A NON_INVENTORY or SERVICE product requires a purchase (expense) account.",
    );
  }
  return { purchaseAccountId: input.purchaseAccountId, inventoryAssetAccountId: null, cogsAccountId: null };
}

async function assertSkuAvailable(tx: TenantDb, organizationId: string, sku: string, excludeId?: string) {
  const rows = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.organizationId, organizationId), eq(products.sku, sku)));
  if (rows.some((r) => r.id !== excludeId)) throw new ProductSkuInUseError(sku);
}

export async function loadProductOr404(tx: TenantDb, organizationId: string, productId: string) {
  const [product] = await tx
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.organizationId, organizationId)));
  if (!product) throw new ProductNotFoundError(productId);
  return product;
}

export const ProductService = {
  async list(actor: Actor, opts: { type?: ProductType; isActive?: boolean } = {}) {
    assertPermission(actor, "product:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(products.organizationId, actor.organizationId)];
      if (opts.type) conditions.push(eq(products.type, opts.type));
      if (opts.isActive !== undefined) conditions.push(eq(products.isActive, opts.isActive));
      return tx
        .select()
        .from(products)
        .where(and(...conditions))
        .orderBy(asc(products.sku));
    });
  },

  async get(actor: Actor, productId: string) {
    assertPermission(actor, "product:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [product] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)));
      return product ?? null;
    });
  },

  async create(actor: Actor, input: CreateProductInput) {
    assertPermission(actor, "product:manage");
    return withTenant(actor.organizationId, async (tx) => {
      if (!input.sku.trim()) throw new InvalidProductError("SKU is required.");
      if (!input.name.trim()) throw new InvalidProductError("Name is required.");
      await assertSkuAvailable(tx, actor.organizationId, input.sku);

      const typeAccounts = resolveTypeAccounts(input);
      await assertAccountsUsable(
        tx,
        actor.organizationId,
        [input.revenueAccountId, typeAccounts.purchaseAccountId, typeAccounts.inventoryAssetAccountId, typeAccounts.cogsAccountId].filter(
          (id): id is string => !!id,
        ),
      );
      if (input.preferredSupplierContactId) {
        const [supplier] = await tx
          .select()
          .from(contacts)
          .where(
            and(eq(contacts.id, input.preferredSupplierContactId), eq(contacts.organizationId, actor.organizationId)),
          );
        if (!supplier || (supplier.kind !== "SUPPLIER" && supplier.kind !== "BOTH")) {
          throw new InvalidProductError("Preferred supplier must be an active supplier contact.");
        }
      }

      const [created] = await tx
        .insert(products)
        .values({
          organizationId: actor.organizationId,
          sku: input.sku.trim(),
          name: input.name.trim(),
          description: input.description ?? null,
          type: input.type,
          sellPrice: input.sellPrice ?? null,
          revenueAccountId: input.revenueAccountId,
          purchaseAccountId: typeAccounts.purchaseAccountId,
          inventoryAssetAccountId: typeAccounts.inventoryAssetAccountId,
          cogsAccountId: typeAccounts.cogsAccountId,
          reorderPoint: input.reorderPoint ?? null,
          reorderQuantity: input.reorderQuantity ?? null,
          preferredSupplierContactId: input.preferredSupplierContactId ?? null,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create product.");

      await AuditService.record(tx, actor, {
        action: "product.created",
        entityType: "Product",
        entityId: created.id,
        after: { sku: created.sku, name: created.name, type: created.type },
      });

      return created;
    });
  },

  async update(actor: Actor, productId: string, input: UpdateProductInput) {
    assertPermission(actor, "product:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadProductOr404(tx, actor.organizationId, productId);
      if (!input.name.trim()) throw new InvalidProductError("Name is required.");
      if (input.sku !== existing.sku) await assertSkuAvailable(tx, actor.organizationId, input.sku, productId);
      if (input.type !== existing.type && Number(existing.quantityOnHand) !== 0) {
        throw new InvalidProductError(
          `${existing.sku} has ${existing.quantityOnHand} units on hand — change its type only once it's back to zero.`,
        );
      }

      const typeAccounts = resolveTypeAccounts(input);
      await assertAccountsUsable(
        tx,
        actor.organizationId,
        [input.revenueAccountId, typeAccounts.purchaseAccountId, typeAccounts.inventoryAssetAccountId, typeAccounts.cogsAccountId].filter(
          (id): id is string => !!id,
        ),
      );

      const [updated] = await tx
        .update(products)
        .set({
          sku: input.sku.trim(),
          name: input.name.trim(),
          description: input.description ?? null,
          type: input.type,
          sellPrice: input.sellPrice ?? null,
          revenueAccountId: input.revenueAccountId,
          purchaseAccountId: typeAccounts.purchaseAccountId,
          inventoryAssetAccountId: typeAccounts.inventoryAssetAccountId,
          cogsAccountId: typeAccounts.cogsAccountId,
          reorderPoint: input.reorderPoint ?? null,
          reorderQuantity: input.reorderQuantity ?? null,
          preferredSupplierContactId: input.preferredSupplierContactId ?? null,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(products.id, productId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "product.updated",
        entityType: "Product",
        entityId: productId,
        before: { sku: existing.sku, name: existing.name },
        after: { sku: input.sku, name: input.name },
      });

      return updated;
    });
  },

  async setActive(actor: Actor, productId: string, isActive: boolean) {
    assertPermission(actor, "product:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadProductOr404(tx, actor.organizationId, productId);

      const [updated] = await tx
        .update(products)
        .set({ isActive, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(products.id, productId))
        .returning();

      await AuditService.record(tx, actor, {
        action: isActive ? "product.reactivated" : "product.deactivated",
        entityType: "Product",
        entityId: productId,
        before: { isActive: existing.isActive },
        after: { isActive },
      });

      return updated;
    });
  },
};
