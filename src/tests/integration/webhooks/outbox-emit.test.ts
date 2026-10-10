import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { eventsOf } from "../../helpers/webhooks";
import { withTenant } from "@/db/tenant";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { PaymentAllocationService } from "@/domain/sales/payment-service";
import { BillService } from "@/domain/purchases/bill-service";
import { ContactService } from "@/domain/contacts/contact-service";
import type { Actor } from "@/domain/permissions/permission-service";
import * as S from "@/domain/api/schemas";
import { EVENT_TYPES, MAX_EVENT_PAYLOAD_BYTES, buildEnvelope } from "@/domain/webhooks/events";

/**
 * The transactional outbox (docs/architecture.md section 11): events are written in the SAME transaction as the business
 * change, carry the public API's DTO and nothing else, and are emitted exactly once per transition.
 */
describe("outbox emit points", () => {
  afterAll(closeTestPools);

  let owner: Actor;
  let orgId: string;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let purchases: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("outbox");
    owner = org.owner;
    orgId = org.organizationId;
    sales = await createSalesFixtures(owner, org.baseCurrency);
    purchases = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  const invoiceInput = () => ({
    customerContactId: sales.customerContactId,
    issueDate: new Date("2026-01-01"),
    dueDate: new Date("2026-01-31"),
    currency: "AUD",
    arAccountId: sales.arAccountId,
    lines: [{ description: "Consulting", quantity: "10", unitPrice: "100.00", accountId: sales.revenueAccountId, taxCodeId: sales.taxCodeId }],
  });
  const billInput = () => ({
    supplierContactId: purchases.supplierContactId,
    issueDate: new Date("2026-01-01"),
    dueDate: new Date("2026-01-31"),
    currency: "AUD",
    apAccountId: purchases.apAccountId,
    lines: [{ description: "Paper", quantity: "2", unitPrice: "50.00", accountId: purchases.expenseAccountId, taxCodeId: purchases.taxCodeId }],
  });

  const typesNow = async () => (await eventsOf(orgId)).map((e) => e.type);

  it("a rolled-back invoice leaves NO event (atomic with the business change)", async () => {
    const before = (await eventsOf(orgId, "invoice.created")).length;
    await expect(
      withTenant(orgId, async (tx) => {
        await InvoiceService.createIn(tx, owner, invoiceInput());
        throw new Error("simulated failure after the invoice was written");
      }),
    ).rejects.toThrow("simulated failure");
    expect((await eventsOf(orgId, "invoice.created")).length).toBe(before);
    expect(await InvoiceService.list(owner)).toHaveLength(0);

    // ...and a committed one leaves exactly one.
    await withTenant(orgId, (tx) => InvoiceService.createIn(tx, owner, invoiceInput()));
    expect((await eventsOf(orgId, "invoice.created")).length).toBe(before + 1);
  });

  it("a rolled-back bill and contact leave no event either", async () => {
    const before = (await eventsOf(orgId)).length;
    await expect(
      withTenant(orgId, async (tx) => {
        await BillService.createIn(tx, owner, billInput());
        await ContactService.createIn(tx, owner, { kind: "CUSTOMER", displayName: "Ghost", currency: "AUD" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await eventsOf(orgId)).length).toBe(before);
  });

  it("customer.created / supplier.created fire exactly once, by contact kind (a BOTH contact is each)", async () => {
    const base = await eventsOf(orgId);
    await ContactService.create(owner, { kind: "CUSTOMER", displayName: "C1", currency: "AUD" });
    await ContactService.create(owner, { kind: "SUPPLIER", displayName: "S1", currency: "AUD" });
    await ContactService.create(owner, { kind: "BOTH", displayName: "B1", currency: "AUD", email: "b1@example.com" });
    const added = (await eventsOf(orgId)).slice(base.length);
    expect(added.map((e) => e.type).sort()).toEqual(["customer.created", "customer.created", "supplier.created", "supplier.created"]);
    for (const e of added) S.ContactOut.parse((e.payload as { data: { object: unknown } }).data.object);
    // No ledger-internal column leaked.
    const body = JSON.stringify(added.map((e) => e.payload));
    expect(body).not.toMatch(/organization_id|organizationId|created_by|createdBy|updated_by/);
  });

  it("invoice.created: one event, the API's InvoiceOut shape with lines, money as strings", async () => {
    const created = await InvoiceService.create(owner, invoiceInput());
    const events = await eventsOf(orgId, "invoice.created");
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.aggregateType).toBe("Invoice");
    expect(e.aggregateId).toBe(created.id);
    expect(e.dispatchedAt).toBeNull();
    const envelope = e.payload as { id: string; type: string; api_version: string; created_at: string; data: { object: Record<string, unknown> } };
    expect(Object.keys(envelope).sort()).toEqual(["api_version", "created_at", "data", "id", "type"]);
    expect(envelope.id).toBe(e.id);
    expect(envelope.api_version).toBe("v1");
    expect(envelope.type).toBe("invoice.created");
    const object = S.InvoiceOut.parse(envelope.data.object); // strict: any extra field would throw
    expect(object.status).toBe("DRAFT");
    expect(object.total).toEqual({ amount: "1100.00", currency: "AUD" });
    expect(object.lines).toHaveLength(1);
    expect(typeof object.total.amount).toBe("string");
  });

  it("an UPDATE of a draft emits no invoice.created", async () => {
    const created = await InvoiceService.create(owner, invoiceInput());
    await InvoiceService.update(owner, created.id, invoiceInput());
    expect(await eventsOf(orgId, "invoice.created")).toHaveLength(1);
  });

  it("invoice.sent is emitted on the real APPROVED -> SENT transition only, never repeated", async () => {
    const created = await InvoiceService.create(owner, invoiceInput());
    await InvoiceService.approveAndPost(owner, created.id);
    expect(await eventsOf(orgId, "invoice.sent")).toHaveLength(0);
    await InvoiceService.markSent(owner, created.id);
    await InvoiceService.markSent(owner, created.id); // already SENT: a no-op
    const sent = await eventsOf(orgId, "invoice.sent");
    expect(sent).toHaveLength(1);
    expect(S.InvoiceOut.parse((sent[0]!.payload as { data: { object: unknown } }).data.object).status).toBe("SENT");
  });

  it("payment.received then invoice.paid on a full payment; a partial payment emits only payment.received", async () => {
    const full = await InvoiceService.create(owner, invoiceInput());
    const part = await InvoiceService.create(owner, invoiceInput());
    await InvoiceService.approveAndPost(owner, full.id);
    await InvoiceService.approveAndPost(owner, part.id);

    await PaymentAllocationService.recordPayment(owner, {
      customerContactId: sales.customerContactId,
      paymentDate: new Date("2026-01-15"),
      amount: "500.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      depositAccountId: sales.bankGlAccountId,
      allocations: [{ invoiceId: part.id, amount: "500.00" }],
    });
    expect(await eventsOf(orgId, "payment.received")).toHaveLength(1);
    expect(await eventsOf(orgId, "invoice.paid")).toHaveLength(0);

    await PaymentAllocationService.recordPayment(owner, {
      customerContactId: sales.customerContactId,
      paymentDate: new Date("2026-01-16"),
      amount: "1100.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      depositAccountId: sales.bankGlAccountId,
      allocations: [{ invoiceId: full.id, amount: "1100.00" }],
    });
    const received = await eventsOf(orgId, "payment.received");
    const paid = await eventsOf(orgId, "invoice.paid");
    expect(received).toHaveLength(2);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.aggregateId).toBe(full.id);
    const payment = S.ReceiptOut.parse((received[1]!.payload as { data: { object: unknown } }).data.object);
    expect(payment.allocations).toEqual([{ invoice_id: full.id, invoice_number: expect.any(String), amount: { amount: "1100.00", currency: "AUD" } }]);
    const invoice = S.InvoiceOut.parse((paid[0]!.payload as { data: { object: unknown } }).data.object);
    expect(invoice.status).toBe("PAID");
    expect(invoice.amount_due).toEqual({ amount: "0.00", currency: "AUD" });
  });

  it("bill.created on creation and bill.approved on approval, each once, with the BillOut shape", async () => {
    const created = await BillService.create(owner, billInput());
    expect(await eventsOf(orgId, "bill.created")).toHaveLength(1);
    expect(await eventsOf(orgId, "bill.approved")).toHaveLength(0);
    await BillService.approveAndPost(owner, created.id);
    const approved = await eventsOf(orgId, "bill.approved");
    expect(approved).toHaveLength(1);
    const bill = S.BillOut.parse((approved[0]!.payload as { data: { object: unknown } }).data.object);
    expect(bill.status).toBe("APPROVED");
    expect(bill.posted_at).not.toBeNull();
  });

  it("query budget: an emit is ONE insert into domain_events plus the snapshot reads; it never touches subscriptions or deliveries", async () => {
    const statements: string[] = [];
    const original = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const first = args[0] as string | { text?: string };
      statements.push(typeof first === "string" ? first : (first?.text ?? ""));
      return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    try {
      const measure = async (run: () => Promise<unknown>) => {
        statements.length = 0;
        await run();
        return [...statements];
      };
      const contact = await measure(() => ContactService.create(owner, { kind: "CUSTOMER", displayName: "Budget", currency: "AUD" }));
      const invoice = await measure(() => InvoiceService.create(owner, invoiceInput()));
      for (const [name, sql] of [["contact", contact], ["invoice", invoice]] as const) {
        expect(sql.filter((s) => /insert into "domain_events"/i.test(s)), name).toHaveLength(1);
        expect(sql.filter((s) => /webhook_(subscriptions|deliveries|delivery_attempts)/i.test(s)), name).toHaveLength(0);
      }
      // Contact: the row is already in hand, so the emit is exactly the one insert. Invoice: + the same 3 reads GET /invoices/{id} does.
      const emitReads = invoice.filter((s) => /from "invoices"|from "invoice_lines"|from "payment_allocations"/i.test(s)).length;
      console.log(`[query budget] emit: contact.created = 1 insert; invoice.created = 1 insert + 3 snapshot reads (${emitReads} matching reads in the whole create); create total ${invoice.length} statements`);
      expect(contact.filter((s) => /domain_events/i.test(s))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("emits only catalogue types; payroll.completed and bank.transaction.created are not in the catalogue", async () => {
    await InvoiceService.create(owner, invoiceInput());
    for (const type of await typesNow()) expect(EVENT_TYPES as readonly string[]).toContain(type);
    expect(EVENT_TYPES as readonly string[]).not.toContain("payroll.completed");
    expect(EVENT_TYPES as readonly string[]).not.toContain("bank.transaction.created");
  });

  it("an oversize payload drops the bulky collections and says so; it never fails or exceeds the cap", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => ({ line_number: i + 1, description: "x".repeat(200), quantity: "1" }));
    const envelope = buildEnvelope({ id: "e", type: "invoice.created", occurredAt: new Date("2026-01-01T00:00:00Z"), object: { id: "i", total: { amount: "1.00", currency: "AUD" }, lines } });
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
    expect(envelope.data.truncated).toBe(true);
    expect(envelope.data.object).not.toHaveProperty("lines");
    expect(envelope.data.object).toHaveProperty("total");
  });
});
