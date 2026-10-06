import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { call, get, makeKey, post, resetApiThrottle } from "../../helpers/api";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";
import type { Actor } from "@/domain/permissions/permission-service";
import { withTenant } from "@/db/tenant";
import { apiIdempotencyKeys, bills, contacts, invoices } from "@/db/schema";
import { ApiIdempotencyService, LOCK_WAIT_MS } from "@/domain/api/idempotency";

describe("API idempotency: a retry never creates a second document", () => {
  let owner: Actor;
  let orgId: string;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let purchases: Awaited<ReturnType<typeof createPurchasesFixtures>>;
  let key: string;
  let keyId: string;
  const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL, max: 2 });

  beforeEach(async () => {
    await resetDatabase();
    resetApiThrottle();
    const org = await createTestOrg("api-idem");
    owner = org.owner;
    orgId = org.organizationId;
    sales = await createSalesFixtures(owner, org.baseCurrency);
    purchases = await createPurchasesFixtures(owner, org.baseCurrency);
    const k = await makeKey(owner, ["invoices:write", "invoices:read", "bills:write", "contacts:write", "contacts:read"], { rateLimitPerMinute: 600 });
    key = k.secret;
    keyId = k.id;
  });

  afterAll(async () => {
    await admin.end();
    await closeTestPools();
  });

  const invoice = (over: Record<string, unknown> = {}) => ({
    customer_id: sales.customerContactId,
    issue_date: "2026-03-10",
    due_date: "2026-04-10",
    currency: "AUD",
    ar_account_id: sales.arAccountId,
    lines: [{ description: "Consulting", quantity: "2", unit_price: "150.00", account_id: sales.revenueAccountId, tax_code_id: sales.taxCodeId }],
    ...over,
  });
  const count = async (table: typeof invoices | typeof bills | typeof contacts) => (await withTenant(orgId, (tx) => tx.select().from(table))).length;

  it("is REQUIRED for invoice and bill creation (400) and optional for contacts", async () => {
    const noKey = await call("POST", "/invoices", { key, body: invoice() });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe("idempotency_key_required");
    const bill = await call("POST", "/bills", {
      key,
      body: { supplier_id: purchases.supplierContactId, issue_date: "2026-03-10", due_date: "2026-04-10", currency: "AUD", ap_account_id: purchases.apAccountId, lines: [{ description: "x", quantity: "1", unit_price: "1.00", account_id: purchases.expenseAccountId }] },
    });
    expect(bill.body.code).toBe("idempotency_key_required");
    expect((await call("POST", "/customers", { key, body: { display_name: "No key needed", currency: "AUD" } })).status).toBe(201);
    expect(await count(invoices)).toBe(0);
    for (const bad of ["", "has space", "x".repeat(256)]) {
      const r = await call("POST", "/invoices", { key, body: invoice(), headers: { "idempotency-key": bad } });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("replays the stored response for the same key and body, without creating anything again", async () => {
    const first = await post("/invoices", key, invoice(), { idempotencyKey: "order-1001" });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();

    const second = await post("/invoices", key, invoice(), { idempotencyKey: "order-1001" });
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(second.headers.get("location")).toBe(first.headers.get("location"));
    expect(await count(invoices)).toBe(1);

    // JSON key order and whitespace do not matter.
    const reordered = invoice();
    const shuffled = JSON.stringify(Object.fromEntries(Object.entries(reordered).reverse()), null, 4);
    const third = await call("POST", "/invoices", { key, rawBody: shuffled, idempotencyKey: "order-1001" });
    expect(third.headers.get("idempotent-replayed")).toBe("true");
    expect(await count(invoices)).toBe(1);
  });

  it("the same key with a DIFFERENT body is 422 idempotency_key_reuse and creates nothing", async () => {
    await post("/invoices", key, invoice(), { idempotencyKey: "order-1002" });
    const changed = await post("/invoices", key, invoice({ memo: "changed" }), { idempotencyKey: "order-1002" });
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe("idempotency_key_reuse");
    expect(await count(invoices)).toBe(1);
    // The same key on a different endpoint is also a different request.
    const bill = await post(
      "/bills",
      key,
      { supplier_id: purchases.supplierContactId, issue_date: "2026-03-10", due_date: "2026-04-10", currency: "AUD", ap_account_id: purchases.apAccountId, lines: [{ description: "x", quantity: "1", unit_price: "1.00", account_id: purchases.expenseAccountId }] },
      { idempotencyKey: "order-1002" },
    );
    expect(bill.status).toBe(422);
    expect(await count(bills)).toBe(0);
  });

  it("is scoped per API key: two keys may use the same string independently", async () => {
    const other = await makeKey(owner, ["invoices:write"]);
    const a = await post("/invoices", key, invoice(), { idempotencyKey: "shared-string" });
    const b = await post("/invoices", other.secret, invoice(), { idempotencyKey: "shared-string" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotent-replayed")).toBeNull();
    expect(a.body.data.id).not.toBe(b.body.data.id);
    expect(await count(invoices)).toBe(2);
  });

  it("a failed request stores nothing, so the same key can be retried after fixing the request", async () => {
    const bad = await post("/invoices", key, invoice({ customer_id: "00000000-0000-4000-8000-000000000000" }), { idempotencyKey: "retry-me" });
    expect(bad.status).toBe(422);
    expect(await withTenant(orgId, (tx) => tx.select().from(apiIdempotencyKeys))).toHaveLength(0);
    const good = await post("/invoices", key, invoice(), { idempotencyKey: "retry-me" });
    expect(good.status).toBe(201);
    expect(await count(invoices)).toBe(1);
  });

  it("TWO SIMULTANEOUS identical POSTs create exactly ONE invoice; the other replays it", async () => {
    const results = await Promise.all([
      post("/invoices", key, invoice(), { idempotencyKey: "race-1" }),
      post("/invoices", key, invoice(), { idempotencyKey: "race-1" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await count(invoices)).toBe(1);
    expect(results[0]!.body.data.id).toBe(results[1]!.body.data.id);
    const replays = results.filter((r) => r.headers.get("idempotent-replayed") === "true");
    expect(replays).toHaveLength(1);
    expect(await withTenant(orgId, (tx) => tx.select().from(apiIdempotencyKeys))).toHaveLength(1);
  });

  it("FOUR simultaneous identical POSTs (more than the connection pool) still create exactly one invoice", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => post("/invoices", key, invoice(), { idempotencyKey: "race-4" })));
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(results.filter((r) => r.headers.get("idempotent-replayed") === "true")).toHaveLength(3);
    expect(await count(invoices)).toBe(1);
  }, 30_000);

  it("simultaneous POSTs with DIFFERENT keys all succeed with distinct invoice numbers (a number collision is retried, not surfaced)", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => post("/invoices", key, invoice({ memo: `m${i}` }), { idempotencyKey: `distinct-${i}` })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.data.number)).size).toBe(4);
    expect(await count(invoices)).toBe(4);
  }, 30_000);

  it("a duplicate arriving while the first request is still IN PROGRESS gets 409 idempotency_in_progress (bounded wait, not a hang)", async () => {
    // Simulate the first request: a transaction that has claimed the key but not committed yet.
    const holder = await admin.connect();
    try {
      await holder.query("BEGIN");
      const hash = (await import("@/domain/api/idempotency")).requestHash("POST", "/api/v1/invoices", invoice());
      await holder.query(
        "INSERT INTO api_idempotency_keys (organization_id, api_key_id, idempotency_key, request_hash) VALUES ($1, $2, $3, $4)",
        [orgId, keyId, "in-flight", hash],
      );
      const started = Date.now();
      const res = await post("/invoices", key, invoice(), { idempotencyKey: "in-flight" });
      const waited = Date.now() - started;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("idempotency_in_progress");
      expect(res.headers.get("retry-after")).toBeTruthy();
      expect(waited).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 500);
      expect(waited).toBeLessThan(LOCK_WAIT_MS + 5_000);
      expect(await count(invoices)).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, 30_000);

  it("records expire after 24 hours: an expired key is free to use again, and purgeExpired deletes only old rows", async () => {
    await post("/invoices", key, invoice(), { idempotencyKey: "old-key" });
    await post("/invoices", key, invoice({ memo: "recent" }), { idempotencyKey: "recent-key" });
    await admin.query("UPDATE api_idempotency_keys SET created_at = now() - interval '25 hours' WHERE idempotency_key = 'old-key'");

    const reused = await post("/invoices", key, invoice({ memo: "a new request" }), { idempotencyKey: "old-key" });
    expect(reused.status).toBe(201);
    expect(reused.headers.get("idempotent-replayed")).toBeNull();
    expect(await count(invoices)).toBe(3);

    await admin.query("UPDATE api_idempotency_keys SET created_at = now() - interval '30 hours' WHERE idempotency_key = 'recent-key'");
    const purged = await ApiIdempotencyService.purgeExpired(orgId);
    expect(purged).toBe(1);
    const left = await withTenant(orgId, (tx) => tx.select().from(apiIdempotencyKeys));
    expect(left.map((r) => r.idempotencyKey)).toEqual(["old-key"]);
  });

  it("stores the replayable response but no secret, and the rows are invisible to another organization", async () => {
    await post("/invoices", key, invoice(), { idempotencyKey: "secret-check" });
    const rows = await withTenant(orgId, (tx) => tx.select().from(apiIdempotencyKeys));
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(rows[0]).toMatchObject({ responseStatus: 201, idempotencyKey: "secret-check" });
    const other = await createTestOrg("api-idem-other");
    expect(await withTenant(other.organizationId, (tx) => tx.select().from(apiIdempotencyKeys))).toHaveLength(0);
    // Contacts: optional key gives the same replay guarantee.
    const c1 = await post("/customers", key, { display_name: "Once", currency: "AUD" }, { idempotencyKey: "cust-1" });
    const c2 = await post("/customers", key, { display_name: "Once", currency: "AUD" }, { idempotencyKey: "cust-1" });
    expect(c2.headers.get("idempotent-replayed")).toBe("true");
    expect(c2.body.data.id).toBe(c1.body.data.id);
    expect((await get("/customers", key)).body.data.filter((c: { display_name: string }) => c.display_name === "Once")).toHaveLength(1);
  });
});
