import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { ApiError, apiErrors, toApiError, toProblem } from "@/domain/api/errors";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import { PeriodLockedError } from "@/domain/ledger/errors";
import { InvalidContactForBillError, InvalidBillLineError } from "@/domain/purchases/errors";
import { InvalidContactForInvoiceError, InvalidInvoiceLineError } from "@/domain/sales/errors";
import { InvalidScopeError } from "@/domain/api/scopes";
import { accountDto, billDto, contactDto, decimalString, invoiceDto, isoDate, journalDto, money, type DocumentRow } from "@/domain/api/dto";
import { generateApiKey } from "@/domain/api/api-key-format";
import { resolvePrincipal, type KeyLookupRow } from "@/domain/api/api-auth";

describe("error model: every failure maps to one predictable problem", () => {
  const table: Array<[string, unknown, number, string]> = [
    ["permission denied", new PermissionDeniedError("customer_invoice:manage", "READ_ONLY"), 403, "permission_denied"],
    ["period locked", new PeriodLockedError("2026-01", { lockLevel: "HARD_LOCKED", denialCode: "HARD_LOCKED" }), 409, "period_locked"],
    ["invalid customer", new InvalidContactForInvoiceError("x"), 422, "validation_failed"],
    ["invalid supplier", new InvalidContactForBillError("x"), 422, "validation_failed"],
    ["invalid invoice line", new InvalidInvoiceLineError("Line 1: quantity must be greater than zero."), 422, "validation_failed"],
    ["invalid bill line", new InvalidBillLineError("Line 1: bad"), 422, "validation_failed"],
    ["invalid scope", new InvalidScopeError(["x"]), 422, "validation_failed"],
    ["zod", (() => { try { z.strictObject({ a: z.string() }).parse({ a: 1, b: 2 }); } catch (e) { return e; } })(), 422, "validation_failed"],
    ["unique violation (document number race)", Object.assign(new Error("Failed query: insert into invoices"), { cause: { code: "23505", constraint: "invoices_org_invoice_number_unique" } }), 409, "conflict"],
    ["deadlock", Object.assign(new Error("deadlock detected"), { code: "40P01" }), 409, "conflict"],
    ["pool exhausted", Object.assign(new Error("x"), { cause: { code: "EMAXCONNSESSION" } }), 503, "service_unavailable"],
    ["connect timeout", new Error("timeout exceeded when trying to connect"), 503, "service_unavailable"],
    ["a bug", new TypeError("Cannot read properties of undefined (reading 'secretHash')"), 500, "internal_error"],
    ["a driver error with SQL in it", Object.assign(new Error('Failed query: select * from "invoices" where organization_id = $1 params: 0b8a...'), { cause: { code: "42P01", message: "relation does not exist" } }), 500, "internal_error"],
    ["a thrown string", "boom", 500, "internal_error"],
  ];

  it.each(table)("%s", (_name, error, status, code) => {
    const mapped = toApiError(error);
    expect(mapped.status).toBe(status);
    expect(mapped.code).toBe(code);
    const problem = toProblem(mapped, "req-1");
    expect(problem).toMatchObject({ type: `urn:moneymatters:problem:${code}`, status, code, requestId: "req-1" });
    expect(problem.title.length).toBeGreaterThan(3);
  });

  it("never leaks stack traces, SQL, driver text or internal identifiers in a 500", () => {
    const leaky = Object.assign(new Error('Failed query: select * from "invoices" params: org-9f2c'), { stack: "Error: at /srv/app/secret.ts:1:1", cause: { code: "42P01", message: "relation \"invoices\" does not exist" } });
    const body = JSON.stringify(toProblem(toApiError(leaky), "req-2"));
    for (const forbidden of ["select", "invoices", "org-9f2c", "/srv/app", "stack", "42P01", "relation"]) expect(body).not.toContain(forbidden);
  });

  it("describes validation failures field by field, naming unknown keys individually", () => {
    let error: unknown;
    try {
      z.strictObject({ lines: z.array(z.strictObject({ quantity: z.string() })) }).parse({ lines: [{ quantity: 2, extra: 1 }], total: "1" });
    } catch (e) {
      error = e;
    }
    const problem = toProblem(toApiError(error), "r");
    const fields = (problem.errors ?? []).map((e) => e.field).sort();
    expect(fields).toEqual(["lines[0].extra", "lines[0].quantity", "total"]);
  });

  it("a period lock carries the lock level and period; a permission denial carries no role", () => {
    const locked = toProblem(toApiError(new PeriodLockedError("2026-01", { lockLevel: "TAX_LOCKED", denialCode: "TAX_LOCKED" })), "r");
    expect(locked).toMatchObject({ lockLevel: "TAX_LOCKED", period: "2026-01" });
    const denied = JSON.stringify(toProblem(toApiError(new PermissionDeniedError("journal:post", "READ_ONLY")), "r"));
    expect(denied).not.toContain("READ_ONLY");
  });

  it("passes an ApiError through unchanged, with its headers", () => {
    const e = apiErrors.tooManyFailures(7);
    expect(toApiError(e)).toBe(e);
    expect(e.extra.headers).toEqual({ "Retry-After": "7" });
    expect(toProblem(e, "r")).not.toHaveProperty("headers");
  });

  it("uses 404 (never 403) for not-found so existence cannot be probed", () => {
    expect(apiErrors.notFound("invoice").status).toBe(404);
    expect(apiErrors.routeNotFound().status).toBe(404);
    expect(apiErrors.methodNotAllowed("GET").status).toBe(405);
  });

  it("is an ApiError instance for every constructor", () => {
    for (const make of Object.values(apiErrors) as Array<(...a: never[]) => ApiError>) {
      const e = (make as unknown as (...a: unknown[]) => ApiError)(1, 2);
      expect(e).toBeInstanceOf(ApiError);
      expect(e.code).toMatch(/^[a-z_]+$/);
    }
  });
});

describe("wire serialization: no floats", () => {
  it("normalises decimal strings to 2-4 places without ever using a JS number", () => {
    expect(decimalString("100")).toBe("100.00");
    expect(decimalString("100.5000")).toBe("100.50");
    expect(decimalString("0.1")).toBe("0.10");
    expect(decimalString("349.9950")).toBe("349.995");
    expect(decimalString("-12.3400")).toBe("-12.34");
    // Beyond double precision: a float would corrupt these.
    expect(decimalString("123456789012345.6789")).toBe("123456789012345.6789");
    expect(decimalString("0.30000000000000004000")).toBe("0.30");
    expect(decimalString("1.00000000", 8)).toBe("1.00");
    expect(decimalString("1.23456789", 8)).toBe("1.23456789");
  });

  it("money is { amount: string, currency }", () => {
    expect(money("1234.5", "AUD")).toEqual({ amount: "1234.50", currency: "AUD" });
    expect(typeof money("1", "AUD").amount).toBe("string");
  });

  it("dates are calendar dates, timestamps are RFC 3339, and they are never interchanged", () => {
    expect(isoDate(new Date("2026-03-10T00:00:00.000Z"))).toBe("2026-03-10");
    const row: DocumentRow = {
      id: "i", number: "INV-000001", status: "DRAFT", counterpartyId: "c", counterpartyName: "Acme", issueDate: new Date("2026-03-10T00:00:00Z"), dueDate: new Date("2026-04-10T00:00:00Z"),
      currency: "AUD", memo: null, reference: null, controlAccountId: "a", subtotal: "300.0000", taxTotal: "30.0000", total: "330.0000", amountPaid: "100.0000", postedAt: null,
      createdAt: new Date("2026-03-10T09:30:00.123Z"),
    };
    const dto = invoiceDto(row);
    expect(dto.issue_date).toBe("2026-03-10");
    expect(dto.created_at).toBe("2026-03-10T09:30:00.123Z");
    expect(dto.amount_due).toEqual({ amount: "230.00", currency: "AUD" });
    expect(dto.posted_at).toBeNull();
    expect(JSON.stringify(dto)).not.toMatch(/organization|updated|createdBy|hash/i);
    expect(billDto({ ...row, reference: "S-1" })).toMatchObject({ supplier_reference: "S-1", supplier: { id: "c", display_name: "Acme" } });
  });

  it("DTOs are explicit whitelists: internal columns on the row never reach the wire", () => {
    const contact = contactDto({
      id: "1", kind: "CUSTOMER", displayName: "A", legalName: null, email: null, phone: null, taxNumber: null, billingAddress: null, currency: "AUD", isActive: true,
      createdAt: new Date(0), updatedAt: new Date(0), organizationId: "ORG", createdById: "USER", updatedById: "USER",
    } as never);
    expect(Object.keys(contact).sort()).toEqual(["billing_address", "created_at", "currency", "display_name", "email", "id", "is_active", "kind", "legal_name", "phone", "tax_number", "updated_at"]);
    const account = accountDto({ id: "1", code: "1", name: "n", type: "ASSET", subType: null, currency: "AUD", isControlAccount: false, isActive: true, description: null, parentAccountId: null, createdAt: new Date(0), organizationId: "ORG" } as never);
    expect(JSON.stringify(account)).not.toContain("ORG");
    const journal = journalDto({ id: "1", entryNumber: "JE-1", postingDate: new Date(0), memo: null, status: "POSTED", sourceType: "MANUAL", postedAt: null, createdAt: new Date(0), baseCurrency: "AUD", organizationId: "ORG" } as never);
    expect(JSON.stringify(journal)).not.toContain("ORG");
  });
});

describe("resolving a looked-up key into a principal (revoked / expired / creator gone / demoted)", () => {
  const key = generateApiKey();
  const base: KeyLookupRow = {
    id: "k1", organizationId: "o1", prefix: key.prefix, secretHash: key.secretHash, createdByUserId: "u1", scopes: ["invoices:write", "reports:read"],
    expiresAt: null, revokedAt: null, rateLimitPerMinute: null, membershipRole: "ADMINISTRATOR", membershipActive: true, userDisabledAt: null,
  };
  const now = new Date("2026-06-01T00:00:00Z");
  const code = (row: KeyLookupRow, hash = key.secretHash) => {
    try {
      resolvePrincipal(row, hash, now);
      return "ok";
    } catch (e) {
      return (e as ApiError).code;
    }
  };

  it("accepts a healthy key and builds an API actor narrowed to the effective permissions", () => {
    const p = resolvePrincipal(base, key.secretHash, now);
    expect(p.actor).toMatchObject({ userId: "u1", organizationId: "o1", role: "ADMINISTRATOR", type: "API", apiKey: { id: "k1", prefix: key.prefix } });
    expect([...p.permissions].sort()).toEqual(["customer_invoice:manage", "customer_invoice:read", "financial_report:read", "journal:read"]);
    expect(p.actor.grantedPermissions).toBe(p.permissions);
  });

  it("refuses wrong hash, revoked, expired, removed creator, inactive membership and suspended creator, each distinctly", () => {
    expect(code(base, "0".repeat(64))).toBe("invalid_api_key");
    expect(code({ ...base, revokedAt: new Date("2026-05-01") })).toBe("api_key_revoked");
    expect(code({ ...base, expiresAt: new Date("2026-05-31T23:59:59Z") })).toBe("api_key_expired");
    expect(code({ ...base, expiresAt: new Date("2026-06-01T00:00:00Z") })).toBe("api_key_expired");
    expect(code({ ...base, expiresAt: new Date("2026-06-02") })).toBe("ok");
    expect(code({ ...base, membershipRole: null, membershipActive: null })).toBe("api_key_owner_inactive");
    expect(code({ ...base, membershipActive: false })).toBe("api_key_owner_inactive");
    expect(code({ ...base, userDisabledAt: new Date("2026-05-30") })).toBe("api_key_owner_inactive");
  });

  it("the secret is checked FIRST: a wrong secret learns nothing about revocation or expiry", () => {
    expect(code({ ...base, revokedAt: new Date() }, "f".repeat(64))).toBe("invalid_api_key");
    expect(code({ ...base, userDisabledAt: new Date() }, "f".repeat(64))).toBe("invalid_api_key");
  });

  it("re-reads the role every time: a demotion shrinks the very next principal", () => {
    expect(resolvePrincipal({ ...base, membershipRole: "READ_ONLY" }, key.secretHash, now).permissions).toEqual(new Set(["customer_invoice:read", "financial_report:read", "journal:read"]));
    expect(resolvePrincipal({ ...base, membershipRole: "EMPLOYEE" }, key.secretHash, now).permissions.size).toBe(0);
  });
});
