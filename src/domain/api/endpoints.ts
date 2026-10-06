import { z } from "zod/v4";
import Decimal from "decimal.js";
import { assertPermission } from "@/domain/permissions/permission-service";
import type { Permission } from "@/domain/permissions/roles";
import { BillService } from "@/domain/purchases/bill-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { ContactService } from "@/domain/contacts/contact-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { Money as MoneyValue } from "@/domain/money/money";
import { withTenant, type TenantDb } from "@/db/tenant";
import type { ApiPrincipal } from "./api-auth";
import { decodeCursor, encodeCursor, type CursorPosition } from "./cursor";
import { accountDto, billDto, contactDto, invoiceDto, isoDate, journalDto, money, paymentDto, supplierPaymentDto } from "./dto";
import { assertDateOpenForApiDraft } from "./draft-guard";
import { apiErrors } from "./errors";
import { runIdempotent, requestHash } from "./idempotency";
import { buildOpenApiDocument } from "./openapi";
import type { RateLimitState } from "./rate-limit";
import {
  dayEnd,
  getAccount,
  getBill,
  getContact,
  getInvoice,
  getJournal,
  getPayment,
  getSupplierPayment,
  listAccounts,
  listBills,
  listContacts,
  listInvoices,
  listJournals,
  listPayments,
  listSupplierPayments,
  loadBill,
  loadInvoice,
  type Page,
} from "./read-models";
import type { ApiScope } from "./scopes";
import * as S from "./schemas";

/**
 * THE registry of v1 endpoints. One entry per (method, path): its scope, the permissions it needs, its zod input
 * schemas, its response schema and the function that does the work. The route files under src/app/api/v1 are one
 * line each (`export const GET = route(endpoint("invoices.list"))`), the OpenAPI document is generated from this
 * table, and a test fails if a route file, a registry entry or an OpenAPI path exists without the others - so the
 * three cannot drift.
 *
 * v1 is GET / HEAD / POST only: there is deliberately no PUT, PATCH or DELETE (middleware answers 405). Writes are
 * DRAFT-only creations through the existing domain services.
 */
export interface EndpointContext<Q = never, B = never> {
  principal: ApiPrincipal;
  rate: RateLimitState;
  query: Q;
  body: B;
  params: Record<string, string>;
  requestId: string;
  idempotencyKey: string | null;
  /** The URL path of this request (used in the idempotency fingerprint). */
  requestPath: string;
  /** The raw (string) query parameters, for the cursor's filter fingerprint. */
  rawQuery: Record<string, string>;
}

export interface EndpointResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  replayed?: boolean;
}

export type Idempotency = "required" | "optional" | "none";

export interface EndpointDef {
  id: string;
  method: "GET" | "POST";
  /** OpenAPI-style path relative to /api/v1, e.g. "/invoices/{id}". */
  path: string;
  tag: string;
  summary: string;
  description: string;
  /** Scope the key must carry; null = any valid key (`/me`). Ignored for public endpoints. */
  scope: ApiScope | null;
  /** Permissions the effective actor must hold, checked before any database work (the service re-checks). */
  permissions: Permission[];
  /** No authentication at all (only the OpenAPI document): serves nothing tenant-specific. */
  public?: boolean;
  query: z.ZodType;
  body?: z.ZodType;
  idempotency: Idempotency;
  successStatus: 200 | 201;
  response: z.ZodType;
  run: (ctx: EndpointContext<any, any>) => Promise<EndpointResult>;
}

const registry: EndpointDef[] = [];
function define<Q extends z.ZodType, B extends z.ZodType | undefined = undefined>(
  def: Omit<EndpointDef, "query" | "body" | "run"> & {
    query: Q;
    body?: B;
    run: (ctx: EndpointContext<z.output<Q>, B extends z.ZodType ? z.output<B> : never>) => Promise<EndpointResult>;
  },
): EndpointDef {
  const full = def as unknown as EndpointDef;
  registry.push(full);
  return full;
}

export function allEndpoints(): readonly EndpointDef[] {
  return registry;
}

export function endpoint(id: string): EndpointDef {
  const found = registry.find((e) => e.id === id);
  if (!found) throw new Error(`Unknown API endpoint "${id}".`);
  return found;
}

// ---- Helpers ----------------------------------------------------------------------------------------------------

function pageBody<Row, Dto>(
  ctx: EndpointContext<unknown, unknown>,
  endpointId: string,
  page: Page<Row>,
  toDto: (row: Row) => Dto,
) {
  return {
    data: page.items.map(toDto),
    next_cursor: page.next ? encodeCursor(page.next, cursorScope(ctx, endpointId)) : null,
  };
}

/** Endpoint + canonical filters: a cursor is only valid for the query that produced it. */
function cursorScope(ctx: { principal: ApiPrincipal; rawQuery: Record<string, string> }, endpointId: string) {
  const filters = Object.entries(ctx.rawQuery)
    .filter(([k]) => k !== "cursor" && k !== "limit")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return { organizationId: ctx.principal.organizationId, query: `${endpointId}|${filters}` };
}

function pageParams(ctx: EndpointContext<{ limit: number; cursor?: string }, unknown>, endpointId: string): { limit: number; after?: CursorPosition } {
  const after = ctx.query.cursor ? decodeCursor(ctx.query.cursor, cursorScope(ctx, endpointId)) : undefined;
  return { limit: ctx.query.limit, after };
}

function ok<T>(status: 200 | 201, body: T, headers?: Record<string, string>): EndpointResult {
  return { status, body: { data: body }, headers };
}

function notFound(what: string): never {
  throw apiErrors.notFound(what);
}

async function runWriteOnce(
  ctx: EndpointContext<unknown, unknown>,
  work: (tx: TenantDb) => Promise<{ status: number; body: unknown }>,
): Promise<EndpointResult> {
  const organizationId = ctx.principal.organizationId;
  if (ctx.idempotencyKey) {
    const hash = requestHash("POST", ctx.requestPath, ctx.body);
    const result = await runIdempotent({ organizationId, apiKeyId: ctx.principal.keyId }, ctx.idempotencyKey, hash, work);
    return { status: result.status, body: result.body, replayed: result.replayed };
  }
  const result = await withTenant(organizationId, work);
  return { status: result.status, body: result.body };
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e.code ?? e.cause?.code) === "23505";
}

const WRITE_ATTEMPTS = 4;

/**
 * Runs a create inside ONE transaction. With an Idempotency-Key the transaction also holds the idempotency record
 * (see idempotency.ts); without one it is just the work. Either way: one withTenant, the key's organization only.
 *
 * Document numbers (INV-000123) are derived from a row count inside the transaction with a unique index as the
 * backstop, so two DIFFERENT concurrent creates can collide on the number; the loser's transaction (document,
 * audit rows and idempotency record alike) rolls back completely, and it is simply run again - a few attempts with
 * a short jittered pause - rather than surfacing a spurious conflict. Idempotent replays never reach this path.
 */
async function runWrite(
  ctx: EndpointContext<unknown, unknown>,
  work: (tx: TenantDb) => Promise<{ status: number; body: unknown }>,
): Promise<EndpointResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runWriteOnce(ctx, work);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= WRITE_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 60)));
    }
  }
}

const location = (path: string) => ({ Location: `/api/v1${path}` });

// ---- Meta -------------------------------------------------------------------------------------------------------

define({
  id: "me",
  method: "GET",
  path: "/me",
  tag: "Meta",
  summary: "Describe the calling API key",
  description:
    "Returns the organization the key belongs to, its scopes, the permissions it can actually exercise right now (scopes intersected with its creator's current role) and its rate-limit window. Never returns the secret. Costs no database query beyond authentication.",
  scope: null,
  permissions: [],
  query: S.NoQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.oneOf(S.MeOut),
  async run(ctx) {
    const { principal, rate } = ctx;
    return ok(200, {
      organization_id: principal.organizationId,
      api_key: { id: principal.keyId, prefix: principal.prefix, expires_at: principal.expiresAt ? principal.expiresAt.toISOString() : null },
      scopes: principal.scopes,
      effective_permissions: [...principal.permissions].sort(),
      rate_limit: { limit: rate.limit, remaining: rate.remaining, reset_at: new Date(rate.resetAt * 1000).toISOString() },
    });
  },
});

define({
  id: "openapi",
  method: "GET",
  path: "/openapi.json",
  tag: "Meta",
  summary: "The OpenAPI 3.1 document for this API",
  description: "Public and unauthenticated. Contains nothing specific to any organization.",
  scope: null,
  permissions: [],
  public: true,
  query: S.NoQuery,
  idempotency: "none",
  successStatus: 200,
  response: z.looseObject({}),
  async run() {
    return { status: 200, body: buildOpenApiDocument(), headers: { "Cache-Control": "public, max-age=300" } };
  },
});

// ---- Contacts: customers and suppliers ---------------------------------------------------------------------------

function contactEndpoints(kind: "customer" | "supplier") {
  const plural = kind === "customer" ? "customers" : "suppliers";
  const Kind = kind === "customer" ? "CUSTOMER" : "SUPPLIER";
  const kinds = kind === "customer" ? (["CUSTOMER", "BOTH"] as const) : (["SUPPLIER", "BOTH"] as const);
  const Body = kind === "customer" ? S.CreateCustomerBody : S.CreateSupplierBody;

  define({
    id: `${plural}.list`,
    method: "GET",
    path: `/${plural}`,
    tag: kind === "customer" ? "Customers" : "Suppliers",
    summary: `List ${plural}`,
    description: `Newest first. Includes contacts that are both a customer and a supplier. Inactive contacts are hidden unless \`include_inactive=true\`.`,
    scope: "contacts:read",
    permissions: ["contact:read"],
    query: S.ContactListQuery,
    idempotency: "none",
    successStatus: 200,
    response: S.pageOf(S.ContactOut),
    async run(ctx) {
      const page = await listContacts(ctx.principal.actor, { kinds: [...kinds], includeInactive: ctx.query.include_inactive ?? false }, pageParams(ctx, `${plural}.list`));
      return { status: 200, body: pageBody(ctx, `${plural}.list`, page, (r) => contactDto(r.contact)) };
    },
  });

  define({
    id: `${plural}.get`,
    method: "GET",
    path: `/${plural}/{id}`,
    tag: kind === "customer" ? "Customers" : "Suppliers",
    summary: `Get a ${kind}`,
    description: "404 when the id does not exist in this key's organization (including when it exists in another one).",
    scope: "contacts:read",
    permissions: ["contact:read"],
    query: S.NoQuery,
    idempotency: "none",
    successStatus: 200,
    response: S.oneOf(S.ContactOut),
    async run(ctx) {
      const row = await getContact(ctx.principal.actor, ctx.params.id ?? "", [...kinds]);
      return row ? ok(200, contactDto(row)) : notFound(kind);
    },
  });

  define({
    id: `${plural}.create`,
    method: "POST",
    path: `/${plural}`,
    tag: kind === "customer" ? "Customers" : "Suppliers",
    summary: `Create a ${kind}`,
    description: `Creates a ${kind}. \`Idempotency-Key\` is optional but recommended.`,
    scope: "contacts:write",
    permissions: ["contact:manage"],
    query: S.NoQuery,
    body: Body,
    idempotency: "optional",
    successStatus: 201,
    response: S.oneOf(S.ContactOut),
    async run(ctx) {
      const b = ctx.body as z.output<typeof Body>;
      return runWrite(ctx, async (tx) => {
        const created = await ContactService.createIn(tx, ctx.principal.actor, {
          kind: Kind,
          displayName: b.display_name,
          currency: b.currency,
          legalName: b.legal_name,
          email: b.email,
          phone: b.phone,
          taxNumber: b.tax_number,
          billingAddress: b.billing_address,
        });
        return { status: 201, body: { data: contactDto(created) } };
      }).then((r) => ({ ...r, headers: r.status === 201 ? location(`/${plural}/${(r.body as { data: { id: string } }).data.id}`) : undefined }));
    },
  });
}
contactEndpoints("customer");
contactEndpoints("supplier");

// ---- Accounts ---------------------------------------------------------------------------------------------------

define({
  id: "accounts.list",
  method: "GET",
  path: "/accounts",
  tag: "Accounts",
  summary: "List accounts in the chart of accounts",
  description: "Read-only. Newest first; inactive accounts hidden unless `include_inactive=true`.",
  scope: "accounts:read",
  permissions: ["account:read"],
  query: S.AccountListQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.pageOf(S.AccountOut),
  async run(ctx) {
    const page = await listAccounts(ctx.principal.actor, { type: ctx.query.type, includeInactive: ctx.query.include_inactive ?? false }, pageParams(ctx, "accounts.list"));
    return { status: 200, body: pageBody(ctx, "accounts.list", page, (r) => accountDto(r.account)) };
  },
});

define({
  id: "accounts.get",
  method: "GET",
  path: "/accounts/{id}",
  tag: "Accounts",
  summary: "Get an account",
  description: "404 when the id does not exist in this key's organization.",
  scope: "accounts:read",
  permissions: ["account:read"],
  query: S.NoQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.oneOf(S.AccountOut),
  async run(ctx) {
    const row = await getAccount(ctx.principal.actor, ctx.params.id ?? "");
    return row ? ok(200, accountDto(row)) : notFound("account");
  },
});

// ---- Invoices ---------------------------------------------------------------------------------------------------

define({
  id: "invoices.list",
  method: "GET",
  path: "/invoices",
  tag: "Invoices",
  summary: "List sales invoices",
  description: "Newest created first. Filters: status, customer_id, issue date range. List items omit `lines`.",
  scope: "invoices:read",
  permissions: ["customer_invoice:read"],
  query: S.InvoiceListQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.pageOf(S.InvoiceOut),
  async run(ctx) {
    const q = ctx.query;
    const page = await listInvoices(
      ctx.principal.actor,
      {
        status: q.status,
        counterpartyId: q.customer_id,
        issueDateFrom: q.issue_date_from ? S.toUtcDate(q.issue_date_from) : undefined,
        issueDateTo: q.issue_date_to ? S.toUtcDate(q.issue_date_to) : undefined,
      },
      pageParams(ctx, "invoices.list"),
    );
    return { status: 200, body: pageBody(ctx, "invoices.list", page, invoiceDto) };
  },
});

define({
  id: "invoices.get",
  method: "GET",
  path: "/invoices/{id}",
  tag: "Invoices",
  summary: "Get an invoice with its lines",
  description: "404 when the id does not exist in this key's organization.",
  scope: "invoices:read",
  permissions: ["customer_invoice:read"],
  query: S.NoQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.oneOf(S.InvoiceOut),
  async run(ctx) {
    const row = await getInvoice(ctx.principal.actor, ctx.params.id ?? "");
    return row ? ok(200, invoiceDto(row)) : notFound("invoice");
  },
});

define({
  id: "invoices.create",
  method: "POST",
  path: "/invoices",
  tag: "Invoices",
  summary: "Create a DRAFT sales invoice",
  description:
    "Creates a draft only. Tax, line amounts and totals are calculated on the server from the tax codes - the API never accepts client-computed totals. A person must review and post the draft in Money Matters. Requires an `Idempotency-Key` header. Refused (409 `period_locked`) when the issue date falls in a locked period.",
  scope: "invoices:write",
  permissions: ["customer_invoice:manage"],
  query: S.NoQuery,
  body: S.CreateInvoiceBody,
  idempotency: "required",
  successStatus: 201,
  response: S.oneOf(S.InvoiceOut),
  async run(ctx) {
    const b = ctx.body as z.output<typeof S.CreateInvoiceBody>;
    const { actor } = ctx.principal;
    const result = await runWrite(ctx, async (tx) => {
      assertPermission(actor, "customer_invoice:manage");
      const issueDate = S.toUtcDate(b.issue_date);
      await assertDateOpenForApiDraft(tx, actor, issueDate);
      const created = await InvoiceService.createIn(tx, actor, {
        customerContactId: b.customer_id,
        issueDate,
        dueDate: S.toUtcDate(b.due_date),
        currency: b.currency,
        arAccountId: b.ar_account_id,
        memo: b.memo,
        lines: b.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unit_price,
          accountId: l.account_id,
          taxCodeId: l.tax_code_id,
        })),
      });
      const full = await loadInvoice(tx, actor.organizationId, created.id);
      if (!full) throw new Error("Created invoice could not be reloaded.");
      return { status: 201, body: { data: invoiceDto(full) } };
    });
    const id = (result.body as { data: { id: string } }).data.id;
    return { ...result, headers: location(`/invoices/${id}`) };
  },
});

// ---- Bills ------------------------------------------------------------------------------------------------------

define({
  id: "bills.list",
  method: "GET",
  path: "/bills",
  tag: "Bills",
  summary: "List supplier bills",
  description: "Newest created first. Filters: status, supplier_id, issue date range. List items omit `lines`.",
  scope: "bills:read",
  permissions: ["supplier_bill:read"],
  query: S.BillListQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.pageOf(S.BillOut),
  async run(ctx) {
    const q = ctx.query;
    const page = await listBills(
      ctx.principal.actor,
      {
        status: q.status,
        counterpartyId: q.supplier_id,
        issueDateFrom: q.issue_date_from ? S.toUtcDate(q.issue_date_from) : undefined,
        issueDateTo: q.issue_date_to ? S.toUtcDate(q.issue_date_to) : undefined,
      },
      pageParams(ctx, "bills.list"),
    );
    return { status: 200, body: pageBody(ctx, "bills.list", page, billDto) };
  },
});

define({
  id: "bills.get",
  method: "GET",
  path: "/bills/{id}",
  tag: "Bills",
  summary: "Get a bill with its lines",
  description: "404 when the id does not exist in this key's organization.",
  scope: "bills:read",
  permissions: ["supplier_bill:read"],
  query: S.NoQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.oneOf(S.BillOut),
  async run(ctx) {
    const row = await getBill(ctx.principal.actor, ctx.params.id ?? "");
    return row ? ok(200, billDto(row)) : notFound("bill");
  },
});

define({
  id: "bills.create",
  method: "POST",
  path: "/bills",
  tag: "Bills",
  summary: "Create a DRAFT supplier bill",
  description:
    "Creates a draft only; tax and totals are calculated on the server. A person must review and post the draft in Money Matters. Requires an `Idempotency-Key` header. Refused (409 `period_locked`) when the issue date falls in a locked period.",
  scope: "bills:write",
  permissions: ["supplier_bill:manage"],
  query: S.NoQuery,
  body: S.CreateBillBody,
  idempotency: "required",
  successStatus: 201,
  response: S.oneOf(S.BillOut),
  async run(ctx) {
    const b = ctx.body as z.output<typeof S.CreateBillBody>;
    const { actor } = ctx.principal;
    const result = await runWrite(ctx, async (tx) => {
      assertPermission(actor, "supplier_bill:manage");
      const issueDate = S.toUtcDate(b.issue_date);
      await assertDateOpenForApiDraft(tx, actor, issueDate);
      const created = await BillService.createIn(tx, actor, {
        supplierContactId: b.supplier_id,
        issueDate,
        dueDate: S.toUtcDate(b.due_date),
        currency: b.currency,
        apAccountId: b.ap_account_id,
        memo: b.memo,
        supplierReference: b.supplier_reference,
        lines: b.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unit_price,
          accountId: l.account_id,
          taxCodeId: l.tax_code_id,
        })),
      });
      const full = await loadBill(tx, actor.organizationId, created.id);
      if (!full) throw new Error("Created bill could not be reloaded.");
      return { status: 201, body: { data: billDto(full) } };
    });
    const id = (result.body as { data: { id: string } }).data.id;
    return { ...result, headers: location(`/bills/${id}`) };
  },
});

// ---- Payments (read-only) -----------------------------------------------------------------------------------------

define({
  id: "payments.list",
  method: "GET",
  path: "/payments",
  tag: "Payments",
  summary: "List payments received from customers",
  description: "Read-only: the API can never record or move money. Newest created first.",
  scope: "payments:read",
  permissions: ["customer_payment:read"],
  query: S.ReceiptListQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.pageOf(S.ReceiptOut),
  async run(ctx) {
    const q = ctx.query;
    const page = await listPayments(
      ctx.principal.actor,
      { counterpartyId: q.customer_id, dateFrom: q.date_from ? S.toUtcDate(q.date_from) : undefined, dateTo: q.date_to ? S.toUtcDate(q.date_to) : undefined },
      pageParams(ctx, "payments.list"),
    );
    return { status: 200, body: pageBody(ctx, "payments.list", page, paymentDto) };
  },
});

define({
  id: "payments.get",
  method: "GET",
  path: "/payments/{id}",
  tag: "Payments",
  summary: "Get a customer payment with its invoice allocations",
  description: "404 when the id does not exist in this key's organization.",
  scope: "payments:read",
  permissions: ["customer_payment:read"],
  query: S.NoQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.oneOf(S.ReceiptOut),
  async run(ctx) {
    const row = await getPayment(ctx.principal.actor, ctx.params.id ?? "");
    return row ? ok(200, paymentDto(row)) : notFound("payment");
  },
});

define({
  id: "supplier-payments.list",
  method: "GET",
  path: "/supplier-payments",
  tag: "Payments",
  summary: "List payments made to suppliers",
  description: "Read-only. Newest created first.",
  scope: "payments:read",
  permissions: ["supplier_payment:read"],
  query: S.SupplierPaymentListQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.pageOf(S.SupplierPaymentOut),
  async run(ctx) {
    const q = ctx.query;
    const page = await listSupplierPayments(
      ctx.principal.actor,
      { counterpartyId: q.supplier_id, dateFrom: q.date_from ? S.toUtcDate(q.date_from) : undefined, dateTo: q.date_to ? S.toUtcDate(q.date_to) : undefined },
      pageParams(ctx, "supplier-payments.list"),
    );
    return { status: 200, body: pageBody(ctx, "supplier-payments.list", page, supplierPaymentDto) };
  },
});

define({
  id: "supplier-payments.get",
  method: "GET",
  path: "/supplier-payments/{id}",
  tag: "Payments",
  summary: "Get a supplier payment with its bill allocations",
  description: "404 when the id does not exist in this key's organization.",
  scope: "payments:read",
  permissions: ["supplier_payment:read"],
  query: S.NoQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.oneOf(S.SupplierPaymentOut),
  async run(ctx) {
    const row = await getSupplierPayment(ctx.principal.actor, ctx.params.id ?? "");
    return row ? ok(200, supplierPaymentDto(row)) : notFound("supplier payment");
  },
});

// ---- Journals (read-only) ----------------------------------------------------------------------------------------

define({
  id: "journals.list",
  method: "GET",
  path: "/journals",
  tag: "Journals",
  summary: "List journal entries",
  description:
    "Read-only. The v1 API cannot create journal entries: drafting one is gated on the posting permission in the ledger, which no scope may carry. List items omit `lines`.",
  scope: "journals:read",
  permissions: ["journal:read"],
  query: S.JournalListQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.pageOf(S.JournalOut),
  async run(ctx) {
    const q = ctx.query;
    const page = await listJournals(
      ctx.principal.actor,
      { status: q.status, dateFrom: q.date_from ? S.toUtcDate(q.date_from) : undefined, dateTo: q.date_to ? S.toUtcDate(q.date_to) : undefined },
      pageParams(ctx, "journals.list"),
    );
    return { status: 200, body: pageBody(ctx, "journals.list", page, journalDto) };
  },
});

define({
  id: "journals.get",
  method: "GET",
  path: "/journals/{id}",
  tag: "Journals",
  summary: "Get a journal entry with its lines",
  description: "404 when the id does not exist in this key's organization.",
  scope: "journals:read",
  permissions: ["journal:read"],
  query: S.NoQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.oneOf(S.JournalOut),
  async run(ctx) {
    const row = await getJournal(ctx.principal.actor, ctx.params.id ?? "");
    return row ? ok(200, journalDto(row)) : notFound("journal entry");
  },
});

// ---- Reports (read-only) -------------------------------------------------------------------------------------------

const today = () => isoDate(new Date());

define({
  id: "reports.profit-and-loss",
  method: "GET",
  path: "/reports/profit-and-loss",
  tag: "Reports",
  summary: "Profit and loss for a period",
  description: "`from` and `to` are inclusive calendar dates (UTC). Posted journal activity only; drafts are excluded. Amounts are in the organization's base currency.",
  scope: "reports:read",
  permissions: ["financial_report:read"],
  query: S.ProfitAndLossQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.oneOf(S.ProfitAndLossOut),
  async run(ctx) {
    const { from, to } = ctx.query;
    if (to < from) throw apiErrors.invalidQuery([{ field: "to", message: "`to` must not be before `from`." }]);
    const report = await ReportingService.getProfitAndLoss(ctx.principal.actor, { from: S.toUtcDate(from), to: dayEnd(S.toUtcDate(to)) });
    const c = report.currency;
    const line = (l: { accountId: string; code: string; name: string; amount: string }) => ({ account_id: l.accountId, code: l.code, name: l.name, amount: money(l.amount, c) });
    return ok(200, {
      from,
      to,
      currency: c,
      revenue: report.revenue.map(line),
      total_revenue: money(report.totalRevenue, c),
      expenses: report.expenses.map(line),
      total_expenses: money(report.totalExpenses, c),
      net_profit: money(report.netProfit, c),
    });
  },
});

define({
  id: "reports.balance-sheet",
  method: "GET",
  path: "/reports/balance-sheet",
  tag: "Reports",
  summary: "Balance sheet as at a date",
  description: "`as_of` (default today, UTC) is inclusive. Posted journal activity only. Amounts are in the organization's base currency.",
  scope: "reports:read",
  permissions: ["financial_report:read"],
  query: S.BalanceSheetQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.oneOf(S.BalanceSheetOut),
  async run(ctx) {
    const asOf = ctx.query.as_of ?? today();
    const report = await ReportingService.getBalanceSheet(ctx.principal.actor, dayEnd(S.toUtcDate(asOf)));
    const c = report.currency;
    const line = (l: { accountId: string | null; code: string | null; name: string; amount: string }) => ({ account_id: l.accountId, code: l.code, name: l.name, amount: money(l.amount, c) });
    return ok(200, {
      as_of: asOf,
      currency: c,
      assets: report.assets.map(line),
      total_assets: money(report.totalAssets, c),
      liabilities: report.liabilities.map(line),
      total_liabilities: money(report.totalLiabilities, c),
      equity: report.equity.map(line),
      total_equity: money(report.totalEquity, c),
      total_liabilities_and_equity: money(report.totalLiabilitiesAndEquity, c),
      difference: money(report.difference, c),
      is_balanced: report.isBalanced,
    });
  },
});

define({
  id: "reports.trial-balance",
  method: "GET",
  path: "/reports/trial-balance",
  tag: "Reports",
  summary: "Trial balance as at a date",
  description: "`as_of` (default today, UTC) is inclusive. Accounts with no activity are omitted. Amounts are in the organization's base currency.",
  scope: "reports:read",
  permissions: ["financial_report:read", "journal:read"],
  query: S.TrialBalanceQuery,
  idempotency: "none",
  successStatus: 200,
  response: S.oneOf(S.TrialBalanceOut),
  async run(ctx) {
    assertPermission(ctx.principal.actor, "financial_report:read");
    const asOf = ctx.query.as_of ?? today();
    const { currency, rows } = await LedgerService.getTrialBalanceWithCurrency(ctx.principal.actor, dayEnd(S.toUtcDate(asOf)));
    const active = rows.filter((r) => !new Decimal(r.totalDebit).isZero() || !new Decimal(r.totalCredit).isZero());
    const totalDebit = active.reduce((sum, r) => sum.add(MoneyValue.of(r.totalDebit, currency)), MoneyValue.zero(currency));
    const totalCredit = active.reduce((sum, r) => sum.add(MoneyValue.of(r.totalCredit, currency)), MoneyValue.zero(currency));
    return ok(200, {
      as_of: asOf,
      currency,
      rows: active.map((r) => ({
        account_id: r.accountId,
        code: r.code,
        name: r.name,
        type: r.type,
        total_debit: money(r.totalDebit, currency),
        total_credit: money(r.totalCredit, currency),
        balance: money(r.balance, currency),
      })),
      total_debit: money(totalDebit.toString(), currency),
      total_credit: money(totalCredit.toString(), currency),
    });
  },
});

