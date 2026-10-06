import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { instrumentTenant, tracker } from "../../helpers/connection-tracker";

vi.mock("@/db/tenant", async (importOriginal) => instrumentTenant(await importOriginal<typeof import("@/db/tenant")>()));

import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { call, get, makeKey, post, resetApiThrottle } from "../../helpers/api";
import { createSalesFixtures } from "../../helpers/sales";
import { ContactService } from "@/domain/contacts/contact-service";
import type { Actor } from "@/domain/permissions/permission-service";
import pg from "pg";

/**
 * The per-request DATABASE budget (docs/architecture.md section 8): the Supabase session pooler caps the whole
 * project at ~15 clients and DATABASE_POOL_MAX defaults to 3, so a request must cost a small, FIXED number of
 * sequential statements and never more than one connection at a time. Counted at the driver (every statement,
 * including BEGIN / set_config / COMMIT), with the real pipeline and the real database.
 */
describe("API per-request database budget", () => {
  let owner: Actor;
  let key: string;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let statements: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDatabase();
    resetApiThrottle();
    const org = await createTestOrg("api-budget");
    owner = org.owner;
    sales = await createSalesFixtures(owner, org.baseCurrency);
    key = (await makeKey(owner, ["contacts:read", "contacts:write", "accounts:read", "invoices:read", "invoices:write", "reports:read", "journals:read"], { rateLimitPerMinute: 600 })).secret;
    tracker.reset();
    statements = [];
    // Count every statement the driver sends, then call through to the real implementation.
    spy?.mockRestore();
    const original = pg.Client.prototype.query;
    spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const first = args[0] as string | { text?: string };
      statements.push(typeof first === "string" ? first : (first?.text ?? ""));
      return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
  });

  afterAll(async () => {
    spy?.mockRestore();
    await closeTestPools();
  });

  const measure = async (run: () => Promise<{ status: number }>, expectedStatus: number) => {
    statements = [];
    tracker.reset();
    const res = await run();
    expect(res.status).toBe(expectedStatus);
    return { statements: statements.length, tenantCalls: tracker.tenantCalls.length, maxActive: tracker.maxActive, sql: [...statements] };
  };

  const invoiceBody = (lines: number) => ({
    customer_id: sales.customerContactId,
    issue_date: "2026-03-10",
    due_date: "2026-04-10",
    currency: "AUD",
    ar_account_id: sales.arAccountId,
    lines: Array.from({ length: lines }, (_, i) => ({ description: `Line ${i}`, quantity: "1", unit_price: "10.00", account_id: sales.revenueAccountId, tax_code_id: sales.taxCodeId })),
  });

  it("authentication costs exactly two statements (key lookup, rate-limit upsert) and opens no tenant transaction", async () => {
    const m = await measure(() => get("/me", key), 200);
    expect(m.statements).toBe(2);
    expect(m.tenantCalls).toBe(0);
    expect(m.sql[0]).toMatch(/api_key_index/);
    expect(m.sql[1]).toMatch(/api_rate_windows/);
  });

  it("rejections cost nothing or one statement: malformed key 0, unknown prefix 1, rate-limited 2, insufficient scope 2", async () => {
    expect((await measure(() => get("/me", "mm_live_short"), 401)).statements).toBe(0);
    expect((await measure(() => get("/me", null), 401)).statements).toBe(0);
    expect((await measure(() => get("/me", `mm_live_zzzzzzzz_${"A".repeat(43)}`), 401)).statements).toBe(1);
    const narrow = (await makeKey(owner, ["contacts:read"])).secret;
    statements = [];
    const m = await measure(() => get("/invoices", narrow), 403);
    expect(m.statements).toBe(2);
    expect(m.tenantCalls).toBe(0);
    const limited = (await makeKey(owner, ["contacts:read"], { rateLimitPerMinute: 10 })).secret;
    for (let i = 0; i < 10; i += 1) await get("/me", limited);
    expect((await measure(() => get("/me", limited), 429)).statements).toBe(2);
  });

  it("a read is auth (2) + ONE tenant transaction, and the statement count does not grow with the data", async () => {
    const small = await measure(() => get("/customers?limit=25", key), 200);
    expect(small.tenantCalls).toBe(1);
    expect(small.maxActive).toBe(1);
    for (let i = 0; i < 60; i += 1) await ContactService.create(owner, { kind: "CUSTOMER", displayName: `C ${i}`, currency: "AUD" });
    const big = await measure(() => get("/customers?limit=25", key), 200);
    expect(big.statements).toBe(small.statements);
    expect(big.statements).toBeLessThanOrEqual(6); // lookup, rate, BEGIN, set_config, SELECT, COMMIT
    expect(big.sql.filter((s) => /^\s*select/i.test(s) && /from "contacts"/.test(s))).toHaveLength(1);
  });

  it("invoice list and get stay within a fixed handful of statements, independent of how many invoices or lines exist", async () => {
    const created = await post("/invoices", key, invoiceBody(1), { idempotencyKey: "b-1" });
    const one = await measure(() => get("/invoices?limit=25", key), 200);
    for (let i = 0; i < 30; i += 1) await post("/invoices", key, invoiceBody(3), { idempotencyKey: `b-${i + 2}` });
    const many = await measure(() => get("/invoices?limit=25", key), 200);
    expect(many.statements).toBe(one.statements);
    expect(many.statements).toBeLessThanOrEqual(8);
    expect(many.tenantCalls).toBe(1);
    expect(many.maxActive).toBe(1);

    const detail = await measure(() => get(`/invoices/${created.body.data.id}`, key), 200);
    expect(detail.statements).toBeLessThanOrEqual(9);
    expect(detail.tenantCalls).toBe(1);
  });

  it("reports, journals and accounts each run in one tenant transaction with a fixed budget", async () => {
    for (const [path, max] of [
      ["/accounts", 6],
      ["/journals", 7],
      ["/reports/profit-and-loss?from=2026-01-01&to=2026-12-31", 12],
      ["/reports/balance-sheet?as_of=2026-12-31", 14],
      ["/reports/trial-balance?as_of=2026-12-31", 10],
    ] as const) {
      const m = await measure(() => get(path, key), 200);
      expect(m.tenantCalls, path).toBe(1);
      expect(m.maxActive, path).toBe(1);
      expect(m.statements, `${path}: ${m.sql.map((s) => s.slice(0, 40)).join(" | ")}`).toBeLessThanOrEqual(max);
    }
  });

  it("creating a draft invoice is ONE tenant transaction with a statement count that does not depend on the number of lines", async () => {
    await post("/invoices", key, invoiceBody(1), { idempotencyKey: "warm" }); // the lazy idempotency purge runs once per organization
    const one = await measure(() => post("/invoices", key, invoiceBody(1), { idempotencyKey: "c-1" }), 201);
    const five = await measure(() => post("/invoices", key, invoiceBody(5), { idempotencyKey: "c-5" }), 201);
    expect(one.tenantCalls).toBe(1);
    expect(one.maxActive).toBe(1);
    expect(five.statements).toBe(one.statements);
    expect(one.statements).toBeLessThanOrEqual(30);
    // The replay of a completed request is cheaper still: auth + claim + read + commit.
    const replay = await measure(() => post("/invoices", key, invoiceBody(5), { idempotencyKey: "c-5" }), 201);
    expect(replay.tenantCalls).toBe(1);
    expect(replay.statements).toBeLessThanOrEqual(10);
  });

  it("a validation failure is rejected before ANY tenant transaction", async () => {
    const m = await measure(() => call("POST", "/invoices", { key, body: { nope: true }, idempotencyKey: "v-1" }), 422);
    expect(m.tenantCalls).toBe(0);
    expect(m.statements).toBe(2);
  });
});
