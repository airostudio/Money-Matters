import { randomUUID } from "node:crypto";
import { domainEvents } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import { billDto, contactDto, invoiceDto, paymentDto, type ContactRow } from "@/domain/api/dto";
import { loadBill, loadInvoice, loadPayment } from "@/domain/api/read-models";
import { buildEnvelope, type WebhookEventType } from "./events";

/**
 * The write side of the transactional outbox. Every `emit*In` takes the CALLER'S transaction and must be called inside
 * the same `withTenant` transaction as the business change, so an event exists if and only if that change committed - a
 * rolled-back invoice leaves no event.
 *
 * Cost of an emit: ONE INSERT into `domain_events`, plus the read(s) that build the snapshot with the SAME loaders the
 * public API uses (invoice/bill: 3 selects; payment: 2; contact: 0, the row is already in hand). It does NOT match
 * subscriptions, read any other table, or make any network call - matching happens later, in the dispatcher. The payload
 * is the public API DTO and nothing else.
 */
export interface EmitParams {
  type: WebhookEventType;
  aggregateType: string;
  aggregateId: string;
  object: Record<string, unknown>;
}

export const DomainEventService = {
  /** Inserts one outbox row. Returns the event id (also the id consumers dedupe on). */
  async emitIn(tx: TenantDb, organizationId: string, params: EmitParams): Promise<string> {
    const id = randomUUID();
    const occurredAt = new Date();
    const envelope = buildEnvelope({ id, type: params.type, occurredAt, object: params.object });
    await tx.insert(domainEvents).values({
      id,
      organizationId,
      type: params.type,
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      payload: envelope,
      occurredAt,
    });
    return id;
  },

  /** `customer.created` and/or `supplier.created`, by the contact's kind (a BOTH contact is each). Exactly one event per type. */
  async emitContactCreatedIn(tx: TenantDb, organizationId: string, contact: ContactRow): Promise<void> {
    const object = contactDto(contact);
    if (contact.kind === "CUSTOMER" || contact.kind === "BOTH") {
      await this.emitIn(tx, organizationId, { type: "customer.created", aggregateType: "Contact", aggregateId: contact.id, object });
    }
    if (contact.kind === "SUPPLIER" || contact.kind === "BOTH") {
      await this.emitIn(tx, organizationId, { type: "supplier.created", aggregateType: "Contact", aggregateId: contact.id, object });
    }
  },

  async emitInvoiceEventIn(tx: TenantDb, organizationId: string, type: "invoice.created" | "invoice.sent" | "invoice.paid", invoiceId: string): Promise<void> {
    const row = await loadInvoice(tx, organizationId, invoiceId);
    if (!row) return;
    await this.emitIn(tx, organizationId, { type, aggregateType: "Invoice", aggregateId: invoiceId, object: invoiceDto(row) });
  },

  async emitBillEventIn(tx: TenantDb, organizationId: string, type: "bill.created" | "bill.approved", billId: string): Promise<void> {
    const row = await loadBill(tx, organizationId, billId);
    if (!row) return;
    await this.emitIn(tx, organizationId, { type, aggregateType: "Bill", aggregateId: billId, object: billDto(row) });
  },

  async emitPaymentReceivedIn(tx: TenantDb, organizationId: string, paymentId: string): Promise<void> {
    const row = await loadPayment(tx, organizationId, paymentId);
    if (!row) return;
    await this.emitIn(tx, organizationId, { type: "payment.received", aggregateType: "Payment", aggregateId: paymentId, object: paymentDto(row) });
  },
};
