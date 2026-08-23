import { and, asc, eq } from "drizzle-orm";
import { contacts, type contactKindEnum } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";

export type ContactKind = (typeof contactKindEnum.enumValues)[number];

export class ContactNotFoundError extends Error {
  constructor(contactId: string) {
    super(`Contact ${contactId} was not found in this organization.`);
    this.name = "ContactNotFoundError";
  }
}

export interface CreateContactInput {
  kind: ContactKind;
  displayName: string;
  currency: string;
  legalName?: string;
  email?: string;
  phone?: string;
  taxNumber?: string;
  billingAddress?: Record<string, unknown>;
}

export interface UpdateContactInput {
  displayName?: string;
  legalName?: string;
  email?: string;
  phone?: string;
  taxNumber?: string;
  billingAddress?: Record<string, unknown>;
}

export const ContactService = {
  async list(actor: Actor, opts: { kind?: ContactKind; includeInactive?: boolean } = {}) {
    assertPermission(actor, "contact:read");
    return withTenant(actor.organizationId, (tx) => {
      const conditions = [eq(contacts.organizationId, actor.organizationId)];
      if (!opts.includeInactive) conditions.push(eq(contacts.isActive, true));
      if (opts.kind) conditions.push(eq(contacts.kind, opts.kind));
      return tx
        .select()
        .from(contacts)
        .where(and(...conditions))
        .orderBy(asc(contacts.displayName));
    });
  },

  async get(actor: Actor, contactId: string) {
    assertPermission(actor, "contact:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [contact] = await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, actor.organizationId)));
      return contact ?? null;
    });
  },

  async create(actor: Actor, input: CreateContactInput) {
    assertPermission(actor, "contact:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [contact] = await tx
        .insert(contacts)
        .values({
          organizationId: actor.organizationId,
          kind: input.kind,
          displayName: input.displayName,
          currency: input.currency,
          legalName: input.legalName ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          taxNumber: input.taxNumber ?? null,
          billingAddress: input.billingAddress ?? null,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();

      if (!contact) throw new Error("Failed to create contact.");

      await AuditService.record(tx, actor, {
        action: "contact.created",
        entityType: "Contact",
        entityId: contact.id,
        after: contact,
      });

      return contact;
    });
  },

  async update(actor: Actor, contactId: string, input: UpdateContactInput) {
    assertPermission(actor, "contact:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, actor.organizationId)));
      if (!existing) throw new ContactNotFoundError(contactId);

      const [updated] = await tx
        .update(contacts)
        .set({
          displayName: input.displayName ?? existing.displayName,
          legalName: input.legalName !== undefined ? input.legalName : existing.legalName,
          email: input.email !== undefined ? input.email : existing.email,
          phone: input.phone !== undefined ? input.phone : existing.phone,
          taxNumber: input.taxNumber !== undefined ? input.taxNumber : existing.taxNumber,
          billingAddress:
            input.billingAddress !== undefined ? input.billingAddress : existing.billingAddress,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, contactId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "contact.updated",
        entityType: "Contact",
        entityId: contactId,
        before: existing,
        after: updated,
      });

      return updated;
    });
  },

  async setActive(actor: Actor, contactId: string, isActive: boolean) {
    assertPermission(actor, "contact:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, actor.organizationId)));
      if (!existing) throw new ContactNotFoundError(contactId);

      const [updated] = await tx
        .update(contacts)
        .set({ isActive, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(contacts.id, contactId))
        .returning();

      await AuditService.record(tx, actor, {
        action: isActive ? "contact.reactivated" : "contact.deactivated",
        entityType: "Contact",
        entityId: contactId,
        before: { isActive: existing.isActive },
        after: { isActive },
      });

      return updated;
    });
  },
};
