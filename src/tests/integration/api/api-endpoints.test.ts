import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { call, get, makeKey, post, resetApiThrottle } from "../../helpers/api";
import { createSampleAccounts } from "../../helpers/ledger";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { FiscalPeriodService } from "@/domain/ledger/fiscal-period-service";
import { PeriodLockService } from "@/domain/close/period-lock-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { ContactService } from "@/domain/contacts/contact-service";
import type { Actor } from "@/domain/permissions/permission-service";
import { withTenant } from "@/db/tenant";
import { auditLogs, billLines, bills, invoiceLines, invoices, contacts } from "@/db/schema";
import { buildOpenApiDocument } from "@/domain/api/openapi";
import { allEndpoints } from "@/domain/api/endpoints";
import * as S from "@/domain/api/schemas";
import { decimalString } from "@/domain/api/dto";

const ALL_SCOPES = ["contacts:read", "contacts:write", "accounts:read", "invoices:read", "invoices:write", "bills:read", "bills:write", "payments:read", "journals:read", "reports:read"];

describe("Public API v1: endpoints, tenant isolation and draft-only writes", () => {
  let a: { owner: Actor; orgId: string; currency: string };
  let b: { owner: Actor; orgId: string };
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let purchases: Awaited<ReturnType<typeof createPurchasesFixtures>>;
  let keyA: string;
  let keyAId: string;
  let keyB: string;
  let sample: string[];

  beforeEach(async () => {
    await resetDatabase();
    resetApiThrottle();
    const orgA = await createTestOrg("api-a");
    const orgB = await createTestOrg("api-b");
    a = { owner: orgA.owner, orgId: orgA.organizationId, currency: orgA.baseCurrency };
    b = { owner: orgB.owner, orgId: orgB.organizationId };
    sample = await createSampleAccounts(a.owner, a.currency);
    sales = await createSalesFixtures(a.owner, a.currency);
    purchases = await createPurchasesFixtures(a.owner, a.currency);
    const ka = await makeKey(a.owner, ALL_SCOPES);
    keyA = ka.secret;
    keyAId = ka.id;
    keyB = (await makeKey(b.owner, ALL_SCOPES)).secret;
  });

  afterAll(closeTestPools);

  const invoiceBody = (over: Record<string, unknown> = {}) => ({
    customer_id: sales.customerContactId,
    issue_date: "2026-03-10",
    due_date: "2026-04-10",
    currency: "AUD",
    ar_account_id: sales.arAccountId,
    memo: "Via API",
    lines: [
      { description: "Consulting", quantity: "3", unit_price: "100.00", account_id: sales.revenueAccountId, tax_code_id: sales.taxCodeId },
      { description: "Travel", quantity: "1.5", unit_price: "33.33", account_id: sales.otherRevenueAccountId },
    ],
    ...over,
  });

  describe("tenant isolation", () => {
    it("fetching another organization's id by any endpoint is a 404 (never 403), and lists never show other orgs' rows", async () => {
      const invoiceA = await post("/invoices", keyA, invoiceBody(), { idempotencyKey: "k-a-1" });
      expect(invoiceA.status).toBe(201);
      const customerA = (await post("/customers", keyA, { display_name: "Secret Customer A", currency: "AUD" })).body.data;
      const supplierA = (await post("/suppliers", keyA, { display_name: "Secret Supplier A", currency: "AUD" })).body.data;
      const accountId = sample[0] as string;

      for (const path of [
        `/invoices/${invoiceA.body.data.id}`,
        `/customers/${customerA.id}`,
        `/suppliers/${supplierA.id}`,
        `/accounts/${accountId}`,
        `/bills/${invoiceA.body.data.id}`,
        `/journals/${invoiceA.body.data.id}`,
        `/payments/${invoiceA.body.data.id}`,
        `/supplier-payments/${invoiceA.body.data.id}`,
      ]) {
        const res = await get(path, keyB);
        expect(res.status, path).toBe(404);
        expect(res.body.code).toBe("not_found");
        expect(res.text).not.toContain("Secret");
        expect(res.text).not.toContain(a.orgId);
      }
      // ...but org A sees its own.
      expect((await get(`/invoices/${invoiceA.body.data.id}`, keyA)).status).toBe(200);

      for (const path of ["/invoices", "/customers", "/suppliers", "/bills", "/journals", "/payments", "/supplier-payments"]) {
        const res = await get(path, keyB);
        expect(res.status, path).toBe(200);
        expect(res.body.data, path).toEqual([]);
      }
      // Organization B has only its own system accounts; none of A's chart appears.
      const accountsB = await get("/accounts", keyB);
      const accountsA = await get("/accounts", keyA);
      const idsA = new Set(accountsA.body.data.map((x: { id: string }) => x.id));
      expect(accountsA.body.data.length).toBeGreaterThan(accountsB.body.data.length);
      for (const x of accountsB.body.data) expect(idsA.has(x.id)).toBe(false);
      expect(accountsB.text).not.toContain("Business Bank Account");
    });

    it("a customer / account / tax code id from another organization cannot be used to create an invoice (422, no leak, nothing created)", async () => {
      const foreignCustomer = await ContactService.create(b.owner, { kind: "CUSTOMER", displayName: "Foreign Customer Ltd", currency: "AUD" });
      const res = await post("/invoices", keyA, invoiceBody({ customer_id: foreignCustomer.id }), { idempotencyKey: "k-x-1" });
      expect(res.status).toBe(422);
      expect(res.text).not.toContain("Foreign Customer");
      const foreignSales = await createSalesFixtures(b.owner, "AUD");
      for (const over of [
        { ar_account_id: foreignSales.arAccountId },
        { lines: [{ description: "x", quantity: "1", unit_price: "1.00", account_id: foreignSales.revenueAccountId }] },
        { lines: [{ description: "x", quantity: "1", unit_price: "1.00", account_id: sales.revenueAccountId, tax_code_id: foreignSales.taxCodeId }] },
      ]) {
        const r = await post("/invoices", keyA, invoiceBody(over), { idempotencyKey: `k-x-${Math.random()}` });
        expect(r.status).toBe(422);
      }
      const count = await withTenant(a.orgId, (tx) => tx.select().from(invoices));
      expect(count).toHaveLength(0);
    });

    it("a malformed or non-UUID id is a plain 404", async () => {
      expect((await get("/invoices/not-a-uuid", keyA)).status).toBe(404);
      expect((await get("/invoices/00000000-0000-0000-0000-000000000000", keyA)).status).toBe(404);
    });
  });

  describe("draft-only writes through the real domain services", () => {
    it("invoices:write creates a DRAFT whose server-computed totals equal InvoiceService.create for the same input, and nothing is posted", async () => {
      const res = await post("/invoices", keyA, invoiceBody(), { idempotencyKey: "inv-1" });
      expect(res.status).toBe(201);
      const dto = res.body.data;
      expect(dto.status).toBe("DRAFT");
      expect(dto.posted_at).toBeNull();
      expect(res.headers.get("location")).toBe(`/api/v1/invoices/${dto.id}`);

      const direct = await InvoiceService.create(a.owner, {
        customerContactId: sales.customerContactId,
        issueDate: new Date("2026-03-10T00:00:00Z"),
        dueDate: new Date("2026-04-10T00:00:00Z"),
        currency: "AUD",
        arAccountId: sales.arAccountId,
        memo: "Via API",
        lines: [
          { description: "Consulting", quantity: "3", unitPrice: "100.00", accountId: sales.revenueAccountId, taxCodeId: sales.taxCodeId },
          { description: "Travel", quantity: "1.5", unitPrice: "33.33", accountId: sales.otherRevenueAccountId },
        ],
      });
      const directFull = await InvoiceService.get(a.owner, direct.id);
      expect(dto.subtotal.amount).toBe("349.995");
      expect(dto.subtotal.amount).toBe(decimalString(directFull!.subtotal));
      expect(dto.total.amount).toBe(decimalString(directFull!.total));
      expect(dto.tax_total.amount).toBe(decimalString(directFull!.taxTotal));
      expect(dto.tax_total.amount).toBe("30.00");
      expect(dto.tax_total.currency).toBe("AUD");
      expect(dto.lines).toHaveLength(2);
      expect(Number(dto.lines[0].line_amount.amount)).toBe(300);
      expect(Number(dto.lines[0].tax_amount.amount)).toBe(30);
      expect(dto.lines[1].tax_amount.amount).toBe("0.00");
      expect(dto.amount_paid.amount).toBe("0.00");

      // No journal was created: drafting never touches the ledger.
      const journals = await get("/journals", keyA);
      expect(journals.body.data).toEqual([]);
      const row = await InvoiceService.get(a.owner, dto.id);
      expect(row?.status).toBe("DRAFT");
      expect(row?.journalEntryId).toBeNull();
    });

    it("the API-originated audit rows name the key (id, prefix, creator) and the API actor type", async () => {
      const res = await post("/invoices", keyA, invoiceBody(), { idempotencyKey: "audit-1" });
      const rows = await withTenant(a.orgId, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.entityType, "Invoice"), eq(auditLogs.entityId, res.body.data.id))));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.action).toBe("invoice.draft_created");
      expect(row.actorType).toBe("API");
      expect(row.actorUserId).toBe(a.owner.userId);
      expect(row.metadata).toMatchObject({ viaApiKey: true, apiKeyId: keyAId, apiKeyCreatedBy: a.owner.userId });
      expect(JSON.stringify(row)).not.toContain(keyA);
    });

    it("bills:write creates a DRAFT bill the same way, and contacts:write creates customers and suppliers", async () => {
      const res = await post(
        "/bills",
        keyA,
        {
          supplier_id: purchases.supplierContactId,
          issue_date: "2026-03-11",
          due_date: "2026-04-11",
          currency: "AUD",
          ap_account_id: purchases.apAccountId,
          supplier_reference: "SUP-77",
          lines: [{ description: "Paper", quantity: "10", unit_price: "4.50", account_id: purchases.expenseAccountId, tax_code_id: purchases.taxCodeId }],
        },
        { idempotencyKey: "bill-1" },
      );
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: "DRAFT", supplier_reference: "SUP-77" });
      expect(res.body.data.tax_total.amount).toBe("4.50");
      expect(res.body.data.total.amount).toBe("49.50");

      const customer = await post("/customers", keyA, { display_name: "New Co", currency: "AUD", email: "ap@newco.test", billing_address: { city: "Perth" } });
      expect(customer.status).toBe(201);
      expect(customer.body.data).toMatchObject({ kind: "CUSTOMER", display_name: "New Co", is_active: true });
      const supplier = await post("/suppliers", keyA, { display_name: "New Supplier", currency: "AUD" });
      expect(supplier.body.data.kind).toBe("SUPPLIER");
      // A customer is not reachable through /suppliers and vice versa.
      expect((await get(`/suppliers/${customer.body.data.id}`, keyA)).status).toBe(404);
      expect((await get(`/customers/${customer.body.data.id}`, keyA)).status).toBe(200);
    });

    it("refuses to be told the totals, or anything unknown, and rejects JSON numbers for money (422 with field errors)", async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ["total", { total: "999.00" }],
        ["status", { status: "APPROVED" }],
        ["number", { number: "INV-1" }],
        ["lines[0].tax_amount", { lines: [{ description: "x", quantity: "1", unit_price: "1.00", account_id: sales.revenueAccountId, tax_amount: "5.00" }] }],
        ["lines[0].unit_price", { lines: [{ description: "x", quantity: "1", unit_price: 150, account_id: sales.revenueAccountId }] }],
        ["lines[0].quantity", { lines: [{ description: "x", quantity: 2, unit_price: "1.00", account_id: sales.revenueAccountId }] }],
        ["lines[0].unit_price", { lines: [{ description: "x", quantity: "1", unit_price: "-5.00", account_id: sales.revenueAccountId }] }],
        ["lines", { lines: [] }],
        ["issue_date", { issue_date: "2026-02-30" }],
        ["due_date", { due_date: "2026-03-01" }],
        ["currency", { currency: "aud" }],
        ["customer_id", { customer_id: "nope" }],
      ];
      let n = 0;
      for (const [field, over] of cases) {
        n += 1;
        const res = await post("/invoices", keyA, invoiceBody(over), { idempotencyKey: `val-${n}` });
        expect(res.status, field).toBe(422);
        expect(res.body.code).toBe("validation_failed");
        expect(res.body.errors.some((e: { field: string }) => e.field === field || e.field.startsWith(field.split("[")[0] as string)), `${field}: ${res.text}`).toBe(true);
      }
      expect(await withTenant(a.orgId, (tx) => tx.select().from(invoices))).toHaveLength(0);
    });

    it("rejects non-JSON, oversized, empty and invalid JSON bodies with the right problem codes", async () => {
      expect((await call("POST", "/customers", { key: keyA, rawBody: "a=b", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
      expect((await call("POST", "/customers", { key: keyA, rawBody: "{nope" })).body.code).toBe("invalid_json");
      expect((await call("POST", "/customers", { key: keyA, rawBody: "  " })).body.code).toBe("body_required");
      const big = await call("POST", "/customers", { key: keyA, rawBody: JSON.stringify({ display_name: "x".repeat(300_000), currency: "AUD" }) });
      expect(big.status).toBe(413);
      expect((await call("POST", "/customers", { key: keyA, rawBody: "[1,2]" })).status).toBe(422);
    });

    it("a locked period refuses the draft with a typed 409 period_locked carrying the lock level, and persists nothing", async () => {
      const period = await FiscalPeriodService.create(a.owner, { label: "2026-01", startDate: new Date("2026-01-01"), endDate: new Date("2026-01-31") });
      await PeriodLockService.raise(a.owner, { kind: "id", id: period.id }, "HARD_LOCKED");
      const res = await post("/invoices", keyA, invoiceBody({ issue_date: "2026-01-15", due_date: "2026-02-15" }), { idempotencyKey: "locked-1" });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("period_locked");
      expect(res.body.lockLevel).toBe("HARD_LOCKED");
      expect(await withTenant(a.orgId, (tx) => tx.select().from(invoices))).toHaveLength(0);
      expect(await withTenant(a.orgId, (tx) => tx.select().from(invoiceLines))).toHaveLength(0);
      // The failed attempt did not consume the idempotency key: the same key works once the date is fixed.
      const retry = await post("/invoices", keyA, invoiceBody({ issue_date: "2026-03-15", due_date: "2026-04-15" }), { idempotencyKey: "locked-1" });
      expect(retry.status).toBe(201);

      const billRes = await post(
        "/bills",
        keyA,
        {
          supplier_id: purchases.supplierContactId,
          issue_date: "2026-01-20",
          due_date: "2026-02-20",
          currency: "AUD",
          ap_account_id: purchases.apAccountId,
          lines: [{ description: "x", quantity: "1", unit_price: "1.00", account_id: purchases.expenseAccountId }],
        },
        { idempotencyKey: "locked-2" },
      );
      expect(billRes.status).toBe(409);
      expect(await withTenant(a.orgId, (tx) => tx.select().from(bills))).toHaveLength(0);
      expect(await withTenant(a.orgId, (tx) => tx.select().from(billLines))).toHaveLength(0);
    });

    it("even a soft-locked period (which a human may override with a reason) refuses an API draft", async () => {
      const period = await FiscalPeriodService.create(a.owner, { label: "2026-02", startDate: new Date("2026-02-01"), endDate: new Date("2026-02-28") });
      await PeriodLockService.raise(a.owner, { kind: "id", id: period.id }, "SOFT_LOCKED");
      const res = await post("/invoices", keyA, invoiceBody({ issue_date: "2026-02-10", due_date: "2026-03-10" }), { idempotencyKey: "soft-1" });
      expect(res.status).toBe(409);
      expect(res.body.lockLevel).toBe("SOFT_LOCKED");
    });

    it("a read-only creator holding a write scope is refused 403 and nothing is written", async () => {
      // Demote the creator after minting: the key keeps its write SCOPE, but its creator can no longer write.
      const { addTestMember } = await import("../../helpers/db");
      const { OrganizationService } = await import("@/domain/organizations/organization-service");
      const creator = await addTestMember(a.owner, "ADMINISTRATOR", "Soon read only");
      const k = await makeKey(creator, ["invoices:write", "contacts:write"]);
      const m = (await OrganizationService.listMembers(a.owner)).find((x) => x.userId === creator.userId)!;
      await OrganizationService.updateMemberRole(a.owner, m.membershipId, "READ_ONLY");
      const res = await post("/invoices", k.secret, invoiceBody(), { idempotencyKey: "ro-1" });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("permission_denied");
      expect(await withTenant(a.orgId, (tx) => tx.select().from(invoices))).toHaveLength(0);
      const c = await post("/customers", k.secret, { display_name: "Nope", currency: "AUD" });
      expect(c.status).toBe(403);
      expect(await withTenant(a.orgId, (tx) => tx.select().from(contacts).where(eq(contacts.displayName, "Nope")))).toHaveLength(0);
    });
  });

  describe("reads", () => {
    it("serializes money as {amount, currency} decimal strings and dates as YYYY-MM-DD / RFC 3339, never numbers", async () => {
      await post("/invoices", keyA, invoiceBody(), { idempotencyKey: "fmt-1" });
      const list = await get("/invoices", keyA);
      const walk = (value: unknown, path: string) => {
        if (typeof value === "number") {
          // The only numbers on the wire are integer counters (line_number, rate-limit ints).
          expect(Number.isInteger(value), `${path} must not be a fractional number`).toBe(true);
          expect(/amount|total|price|quantity|subtotal|due|paid/.test(path), `${path} looks like money but is a number`).toBe(false);
        } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
        else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      };
      walk(list.body, "$");
      const inv = list.body.data[0];
      expect(inv.total).toEqual({ amount: expect.stringMatching(/^\d+\.\d{2,4}$/), currency: "AUD" });
      expect(inv.issue_date).toBe("2026-03-10");
      expect(inv.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(inv.lines).toBeUndefined(); // list items omit lines
      expect(Object.keys(inv)).not.toContain("organization_id");
      expect(list.text).not.toContain(a.orgId);
      // Every response conforms to its documented schema.
      expect(S.pageOf(S.InvoiceOut).safeParse(list.body).success).toBe(true);
      const one = await get(`/invoices/${inv.id}`, keyA);
      expect(S.oneOf(S.InvoiceOut).safeParse(one.body).success).toBe(true);
    });

    it("list endpoints conform to their documented schemas, and filters work", async () => {
      await post("/invoices", keyA, invoiceBody(), { idempotencyKey: "r-1" });
      await post("/customers", keyA, { display_name: "Zed", currency: "AUD" });
      const posted = await InvoiceService.create(a.owner, {
        customerContactId: sales.customerContactId,
        issueDate: new Date("2026-05-01T00:00:00Z"),
        dueDate: new Date("2026-06-01T00:00:00Z"),
        currency: "AUD",
        arAccountId: sales.arAccountId,
        lines: [{ description: "Posted one", quantity: "1", unitPrice: "100.00", accountId: sales.revenueAccountId }],
      });
      await InvoiceService.approveAndPost(a.owner, posted.id);
      await PostingService.postJournal(a.owner, {
        postingDate: new Date("2026-05-02T00:00:00Z"),
        memo: "Cash sale",
        lines: [
          { accountId: sample[0] as string, debit: "250.00", currency: "AUD" },
          { accountId: sample[4] as string, credit: "250.00", currency: "AUD" },
        ],
      });

      const checks: Array<[string, z.ZodTypeAny]> = [
        ["/customers", S.pageOf(S.ContactOut)],
        ["/suppliers", S.pageOf(S.ContactOut)],
        ["/accounts", S.pageOf(S.AccountOut)],
        ["/invoices", S.pageOf(S.InvoiceOut)],
        ["/bills", S.pageOf(S.BillOut)],
        ["/payments", S.pageOf(S.ReceiptOut)],
        ["/supplier-payments", S.pageOf(S.SupplierPaymentOut)],
        ["/journals", S.pageOf(S.JournalOut)],
        ["/reports/profit-and-loss?from=2026-01-01&to=2026-12-31", S.oneOf(S.ProfitAndLossOut)],
        ["/reports/balance-sheet?as_of=2026-12-31", S.oneOf(S.BalanceSheetOut)],
        ["/reports/trial-balance?as_of=2026-12-31", S.oneOf(S.TrialBalanceOut)],
        ["/me", S.oneOf(S.MeOut)],
      ];
      for (const [path, schema] of checks) {
        const res = await get(path, keyA);
        expect(res.status, path).toBe(200);
        const parsed = schema.safeParse(res.body);
        expect(parsed.success, `${path}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
      }

      const drafts = await get("/invoices?status=DRAFT", keyA);
      expect(drafts.body.data).toHaveLength(1);
      const approved = await get("/invoices?status=APPROVED", keyA);
      expect(approved.body.data).toHaveLength(1);
      const may = await get("/invoices?issue_date_from=2026-05-01&issue_date_to=2026-05-31", keyA);
      expect(may.body.data).toHaveLength(1);
      expect((await get(`/invoices?customer_id=${sales.customerContactId}`, keyA)).body.data).toHaveLength(2);
      expect((await get("/journals?status=POSTED", keyA)).body.data.length).toBeGreaterThanOrEqual(2);
      const journalId = (await get("/journals", keyA)).body.data[0].id;
      const j = await get(`/journals/${journalId}`, keyA);
      expect(S.oneOf(S.JournalOut).safeParse(j.body).success).toBe(true);
      expect(j.body.data.lines.length).toBeGreaterThanOrEqual(2);

      const tb = await get("/reports/trial-balance?as_of=2026-12-31", keyA);
      expect(tb.body.data.total_debit.amount).toBe(tb.body.data.total_credit.amount);
      const pl = await get("/reports/profit-and-loss?from=2026-05-01&to=2026-05-31", keyA);
      expect(pl.body.data.total_revenue.amount).toBe("350.00");
      expect((await get("/reports/profit-and-loss?from=2026-05-31&to=2026-05-01", keyA)).status).toBe(400);
    });

    it("rejects unknown and malformed query parameters with 400 and field detail", async () => {
      const res = await get("/invoices?limit=1000&bogus=1&status=NOPE", keyA);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_query");
      expect(res.body.errors.length).toBeGreaterThanOrEqual(2);
      expect((await get("/invoices?limit=0", keyA)).status).toBe(400);
      expect((await get("/invoices?limit=5&limit=6", keyA)).status).toBe(400);
      expect((await get("/reports/profit-and-loss?from=2026-01-01", keyA)).status).toBe(400);
    });
  });

  describe("scopes", () => {
    it("a key lacking a scope gets 403 insufficient_scope naming it, and /me needs none", async () => {
      const narrow = (await makeKey(a.owner, ["contacts:read"])).secret;
      const res = await get("/invoices", narrow);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "insufficient_scope", requiredScope: "invoices:read" });
      expect((await get("/customers", narrow)).status).toBe(200);
      expect((await get("/me", narrow)).status).toBe(200);
      expect((await post("/invoices", narrow, invoiceBody(), { idempotencyKey: "s-1" })).status).toBe(403);
    });
  });

  describe("OpenAPI", () => {
    it("is served publicly without authentication and describes every endpoint, scope and the security scheme", async () => {
      const res = await get("/openapi.json", null);
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe("3.1.0");
      expect(res.body.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
      expect(Object.keys(res.body.paths).length).toBeGreaterThanOrEqual(20);
      expect(JSON.stringify(res.body)).not.toContain(a.orgId);
      expect(Object.keys(buildOpenApiDocument())).toContain("paths");
      expect(allEndpoints().length).toBeGreaterThan(20);
    });
  });
});

// Imported late to keep the top of the file readable.
import type { z } from "zod/v4";
