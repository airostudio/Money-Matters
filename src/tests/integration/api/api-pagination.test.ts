import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { get, makeKey, post, resetApiThrottle } from "../../helpers/api";
import { createSalesFixtures } from "../../helpers/sales";
import { ContactService } from "@/domain/contacts/contact-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("API cursor pagination", () => {
  let owner: Actor;
  let orgId: string;
  let key: string;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL, max: 1 });

  beforeEach(async () => {
    await resetDatabase();
    resetApiThrottle();
    const org = await createTestOrg("api-page");
    owner = org.owner;
    orgId = org.organizationId;
    sales = await createSalesFixtures(owner, org.baseCurrency);
    key = (await makeKey(owner, ["contacts:read", "contacts:write", "invoices:read"], { rateLimitPerMinute: 600 })).secret;
  });

  afterAll(async () => {
    await admin.end();
    await closeTestPools();
  });

  async function walk(path: string, limit: number, onPage?: (n: number) => Promise<void>) {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const res = await get(`${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, key);
      expect(res.status, res.text).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(limit);
      ids.push(...res.body.data.map((r: { id: string }) => r.id));
      cursor = res.body.next_cursor;
      pages += 1;
      if (onPage) await onPage(pages);
      expect(pages).toBeLessThan(100);
    } while (cursor);
    return { ids, pages };
  }

  it("walks a dataset larger than the page size with no duplicates and no gaps, newest first", async () => {
    // createSalesFixtures made 1 customer already; add 52 more => 53 in total.
    for (let i = 0; i < 52; i += 1) await ContactService.create(owner, { kind: "CUSTOMER", displayName: `Customer ${String(i).padStart(2, "0")}`, currency: "AUD" });
    const { ids, pages } = await walk("/customers", 10);
    expect(ids).toHaveLength(53);
    expect(new Set(ids).size).toBe(53);
    expect(pages).toBe(6);

    const { rows } = await admin.query("SELECT id FROM contacts WHERE organization_id = $1 ORDER BY created_at DESC, id DESC", [orgId]);
    expect(ids).toEqual(rows.map((r: { id: string }) => r.id));
  });

  it("breaks ties between rows with an IDENTICAL created_at by id, without losing or repeating any", async () => {
    // One statement => one transaction timestamp => identical created_at for every row.
    await admin.query(
      `INSERT INTO contacts (organization_id, kind, display_name, currency)
       SELECT $1, 'CUSTOMER', 'Tie ' || g, 'AUD' FROM generate_series(1, 37) g`,
      [orgId],
    );
    const distinct = await admin.query("SELECT count(DISTINCT created_at)::int AS n FROM contacts WHERE display_name LIKE 'Tie %'");
    expect(distinct.rows[0].n).toBe(1);
    const { ids } = await walk("/customers", 7);
    expect(ids).toHaveLength(38);
    expect(new Set(ids).size).toBe(38);
  });

  it("is stable while rows are inserted mid-walk: nothing already in the walk repeats or goes missing", async () => {
    for (let i = 0; i < 29; i += 1) await ContactService.create(owner, { kind: "CUSTOMER", displayName: `Existing ${i}`, currency: "AUD" });
    const before = (await get("/customers?limit=100", key)).body.data.map((r: { id: string }) => r.id) as string[];
    expect(before).toHaveLength(30);

    const inserted: string[] = [];
    const { ids } = await walk("/customers", 8, async (page) => {
      if (page === 2 || page === 3) {
        const c = await post("/customers", key, { display_name: `Newcomer ${page}`, currency: "AUD" });
        inserted.push(c.body.data.id);
      }
    });
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    for (const id of before) expect(ids, `existing row ${id} must still be returned`).toContain(id); // no gaps
    // Rows created after the walk began are newer than the cursor, so a forward walk does not revisit the head.
    for (const id of inserted) expect(ids).not.toContain(id);
  });

  it("returns the default page size of 25 and enforces the maximum of 100", async () => {
    for (let i = 0; i < 30; i += 1) await ContactService.create(owner, { kind: "CUSTOMER", displayName: `C${i}`, currency: "AUD" });
    const def = await get("/customers", key);
    expect(def.body.data).toHaveLength(25);
    expect(def.body.next_cursor).toEqual(expect.any(String));
    expect((await get("/customers?limit=100", key)).status).toBe(200);
    expect((await get("/customers?limit=101", key)).status).toBe(400);
    expect((await get("/customers?limit=0", key)).status).toBe(400);
    expect((await get("/customers?limit=abc", key)).status).toBe(400);
    const last = await get("/customers?limit=100", key);
    expect(last.body.next_cursor).toBeNull();
  });

  it("rejects a tampered cursor with 400, and one minted for a different query, endpoint or organization", async () => {
    for (let i = 0; i < 12; i += 1) await ContactService.create(owner, { kind: "CUSTOMER", displayName: `T${i}`, currency: "AUD" });
    const page = await get("/customers?limit=5", key);
    const cursor = page.body.next_cursor as string;
    expect((await get(`/customers?limit=5&cursor=${encodeURIComponent(cursor)}`, key)).status).toBe(200);

    const flip = cursor.slice(0, -3) + (cursor.endsWith("AAA") ? "BBB" : "AAA");
    for (const bad of [flip, `x${cursor}`, cursor.replace(/^c1\./, "c9."), "garbage", cursor.split(".").slice(0, 2).join(".")]) {
      const res = await get(`/customers?limit=5&cursor=${encodeURIComponent(bad)}`, key);
      expect(res.status, bad).toBe(400);
      expect(res.body.code).toBe("invalid_cursor");
    }
    // Different query: another filter, another endpoint.
    expect((await get(`/customers?limit=5&include_inactive=true&cursor=${encodeURIComponent(cursor)}`, key)).body.code).toBe("invalid_cursor");
    const crossEndpoint = await get(`/suppliers?limit=5&cursor=${encodeURIComponent(cursor)}`, key); // contacts:read covers suppliers too
    expect(crossEndpoint.status).toBe(400);
    expect(crossEndpoint.body.code).toBe("invalid_cursor");
  });

  it("a cursor from one organization is useless in another (it cannot be used to reach across tenants)", async () => {
    for (let i = 0; i < 12; i += 1) await ContactService.create(owner, { kind: "CUSTOMER", displayName: `Org A ${i}`, currency: "AUD" });
    const cursor = (await get("/customers?limit=5", key)).body.next_cursor as string;
    const other = await createTestOrg("api-page-other");
    const otherKey = (await makeKey(other.owner, ["contacts:read"])).secret;
    for (let i = 0; i < 12; i += 1) await ContactService.create(other.owner, { kind: "CUSTOMER", displayName: `Org B ${i}`, currency: "AUD" });
    const res = await get(`/customers?limit=5&cursor=${encodeURIComponent(cursor)}`, otherKey);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_cursor");
    expect(res.text).not.toContain("Org A");
    // And B's own walk shows only B.
    const { ids } = await (async () => {
      const r = await get("/customers?limit=100", otherKey);
      return { ids: r.body.data.map((c: { display_name: string }) => c.display_name) as string[] };
    })();
    expect(ids.every((n) => n.startsWith("Org B"))).toBe(true);
  });

  it("paginates filtered invoice lists consistently", async () => {
    for (let i = 0; i < 14; i += 1) {
      await InvoiceService.create(owner, {
        customerContactId: sales.customerContactId,
        issueDate: new Date(Date.UTC(2026, i < 7 ? 2 : 3, 10 + i)),
        dueDate: new Date(Date.UTC(2026, 5, 1)),
        currency: "AUD",
        arAccountId: sales.arAccountId,
        lines: [{ description: `Line ${i}`, quantity: "1", unitPrice: "10.00", accountId: sales.revenueAccountId }],
      });
    }
    const all = await walk("/invoices", 4);
    expect(all.ids).toHaveLength(14);
    const april = await walk("/invoices?issue_date_from=2026-04-01&issue_date_to=2026-04-30", 3);
    expect(april.ids).toHaveLength(7);
    expect(new Set(april.ids).size).toBe(7);
    const drafts = await walk("/invoices?status=DRAFT", 5);
    expect(drafts.ids).toHaveLength(14);
    expect((await walk("/invoices?status=PAID", 5)).ids).toHaveLength(0);
  });
});
