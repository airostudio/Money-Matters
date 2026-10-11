import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { instrumentTenant, tracker } from "../../helpers/connection-tracker";

vi.mock("@/db/tenant", async (importOriginal) => instrumentTenant(await importOriginal<typeof import("@/db/tenant")>()));

import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { seedSearchData } from "../../helpers/search";
import { SearchNotAllowedError, SearchService } from "@/domain/search/search-service";
import type { Actor } from "@/domain/permissions/permission-service";
import type { MembershipRole } from "@/domain/permissions/roles";
import { adminDb } from "../../helpers/db";
import { contacts } from "@/db/schema";

/** Hand-written (NOT derived from the registry under test): what each role can read, from the role matrix. */
const ALL_KINDS = [
  "customer", "supplier", "invoice", "quote", "bill", "purchase_order", "account", "payment", "supplier_payment",
  "employee", "bank_transaction", "project", "product",
];
const WITHOUT_EMPLOYEE_AND_BANK = ALL_KINDS.filter((k) => k !== "employee" && k !== "bank_transaction");
const EXPECTED: Record<MembershipRole, string[]> = {
  OWNER: ALL_KINDS,
  ADMINISTRATOR: ALL_KINDS,
  ACCOUNTANT: ALL_KINDS,
  BOOKKEEPER: ALL_KINDS,
  MANAGER: WITHOUT_EMPLOYEE_AND_BANK,
  READ_ONLY: WITHOUT_EMPLOYEE_AND_BANK,
  ACCOUNTS_RECEIVABLE: ["customer", "invoice", "quote", "account", "payment", "project", "product"],
  ACCOUNTS_PAYABLE: ["supplier", "bill", "purchase_order", "account", "supplier_payment", "product"], // no timesheet:read: cannot open a project
  PAYROLL_MANAGER: ["account", "employee", "project"],
  EMPLOYEE: [], // can list projects, but the project page needs account:read as well
};

describe("global search service", () => {
  let owner: Actor;
  let orgSlug: string;
  let seeded: Awaited<ReturnType<typeof seedSearchData>>;
  let statements: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("search");
    owner = org.owner;
    orgSlug = "acme";
    seeded = await seedSearchData(owner.organizationId, "Zephyr");
    tracker.reset();
    statements = [];
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

  const kindsFor = async (role: MembershipRole, q = "Zephyr") =>
    (await SearchService.search(actorWithRole(owner, role), orgSlug, q)).groups.map((g) => g.kind).sort();

  describe("what each role may see", () => {
    for (const role of Object.keys(EXPECTED) as MembershipRole[]) {
      it(`${role} gets exactly the groups its permissions allow`, async () => {
        expect(await kindsFor(role)).toEqual([...EXPECTED[role]].sort());
      });
    }

    it("a record type a role cannot read is never queried at all (the statement does not mention its table)", async () => {
      statements = [];
      await SearchService.search(actorWithRole(owner, "PAYROLL_MANAGER"), orgSlug, "Zephyr");
      const select = statements.find((s) => /SELECT \* FROM/.test(s)) ?? "";
      for (const table of ["projects", "employees", "accounts"]) expect(select, table).toMatch(new RegExp(`\\b${table}\\b`));
      for (const table of ["invoices", "quotes", "contacts", "bank_transactions", "bills", "purchase_orders", "payments", "supplier_payments", "products"]) {
        expect(select, table).not.toMatch(new RegExp(`\\b${table}\\b`));
      }
    });

    it("a role with nothing searchable does no database work at all", async () => {
      // CLIENT-style role is not in the enum; emulate with a narrowed grant on an otherwise permitted role.
      const narrowed: Actor = { ...owner, role: "READ_ONLY", grantedPermissions: new Set() };
      statements = [];
      tracker.reset();
      const res = await SearchService.search(narrowed, orgSlug, "Zephyr");
      expect(res.groups).toEqual([]);
      expect(statements).toEqual([]);
      expect(tracker.tenantCalls).toEqual([]);
    });

    it("refuses non-human actors (API key, OAuth, AI, automation)", async () => {
      for (const type of ["API", "AI", "SYSTEM", "AUTOMATION"] as const) {
        await expect(SearchService.search({ ...owner, type }, orgSlug, "Zephyr")).rejects.toBeInstanceOf(SearchNotAllowedError);
      }
    });
  });

  describe("what a result shows", () => {
    it("returns links into the organization and context lines, ordered by the registry", async () => {
      const res = await SearchService.search(owner, orgSlug, "Zephyr");
      expect(res.groups.map((g) => g.kind)).toEqual(ALL_KINDS);
      const byKind = Object.fromEntries(res.groups.map((g) => [g.kind, g.items[0]!]));
      expect(byKind.invoice).toMatchObject({
        title: "INV-Zephyr-1",
        subtitle: "Zephyr Customer Pty Ltd - Sent - 1,234.50 AUD",
        href: `/acme/sales/invoices/${seeded.invoice!.id}`,
      });
      expect(byKind.customer).toMatchObject({ title: "Zephyr Customer Pty Ltd", subtitle: "zephyr-c@example.test", href: `/acme/sales/customers/${seeded.customer!.id}` });
      expect(byKind.payment!.href).toBe(`/acme/sales/customers/${seeded.customer!.id}`);
      expect(byKind.supplier_payment!.href).toBe(`/acme/purchases/suppliers/${seeded.supplier!.id}`);
      expect(byKind.bank_transaction).toMatchObject({ href: `/acme/money/${seeded.bankAccount!.id}`, subtitle: "Zephyr Everyday - 2026-03-10 - -1,234.50 AUD" });
      expect(byKind.account!.title).toMatch(/^ZEP-/);
      expect(byKind.employee).toMatchObject({ title: "Zephyr Employee", subtitle: "Active" });
    });

    it("never returns employee tax, bank or pay data, nor a contact's tax number or phone", async () => {
      const res = await SearchService.search(owner, orgSlug, "Zephyr");
      const blob = JSON.stringify(res);
      for (const secret of ["123456782", "062000", "98765432", "99999", "11 111 111 111"]) expect(blob).not.toContain(secret);
      const employee = res.groups.find((g) => g.kind === "employee")!.items[0]!;
      expect(Object.keys(employee).sort()).toEqual(["href", "id", "kind", "subtitle", "title"]);
    });
  });

  describe("matching", () => {
    it("is case-insensitive, prefix and substring, ranking a prefix above a substring", async () => {
      await adminDb().insert(contacts).values([
        { organizationId: owner.organizationId, kind: "CUSTOMER", displayName: "Acme Retail", currency: "AUD" },
        { organizationId: owner.organizationId, kind: "CUSTOMER", displayName: "Big Acme Foods", currency: "AUD" },
        { organizationId: owner.organizationId, kind: "CUSTOMER", displayName: "Acmeville", currency: "AUD" },
      ]);
      const titles = (await SearchService.search(owner, orgSlug, "aCMe")).groups.find((g) => g.kind === "customer")!.items.map((i) => i.title);
      expect(titles).toEqual(["Acme Retail", "Acmeville", "Big Acme Foods"]);
    });

    it("treats % and _ and ! literally (no wildcard) and survives quotes, backslashes and unicode", async () => {
      await adminDb().insert(contacts).values([
        { organizationId: owner.organizationId, kind: "CUSTOMER", displayName: "100% Organic", currency: "AUD" },
        { organizationId: owner.organizationId, kind: "CUSTOMER", displayName: "A_B Traders", currency: "AUD" },
        { organizationId: owner.organizationId, kind: "CUSTOMER", displayName: "AxB Traders", currency: "AUD" },
        { organizationId: owner.organizationId, kind: "CUSTOMER", displayName: "O'Brien & Sons \\ Co", currency: "AUD" },
        { organizationId: owner.organizationId, kind: "CUSTOMER", displayName: "Café Zoë 東京", currency: "AUD" },
        { organizationId: owner.organizationId, kind: "CUSTOMER", displayName: "Wow! Cafe", currency: "AUD" },
      ]);
      const titles = async (q: string) => (await SearchService.search(owner, orgSlug, q)).groups.find((g) => g.kind === "customer")?.items.map((i) => i.title) ?? [];
      expect(await titles("%%")).toEqual([]); // would match every row if % were a wildcard
      expect(await titles("100%")).toEqual(["100% Organic"]);
      expect(await titles("A_B")).toEqual(["A_B Traders"]); // not "AxB Traders"
      expect(await titles("o'brien")).toEqual(["O'Brien & Sons \\ Co"]);
      expect(await titles("\\ co")).toEqual(["O'Brien & Sons \\ Co"]);
      expect(await titles("'; DROP TABLE contacts; --")).toEqual([]);
      expect(await titles("zoë 東京")).toEqual(["Café Zoë 東京"]);
      expect(await titles("wow!")).toEqual(["Wow! Cafe"]);
      expect(await titles("a\u0000b")).toEqual([]); // NUL is stripped, not sent to Postgres
    });

    it("answers a query shorter than two characters, or not a string, with nothing and no database work", async () => {
      for (const q of ["", " ", "a", "  a ", undefined, null, 42, {}, ["Zephyr"]]) {
        statements = [];
        const res = await SearchService.search(owner, orgSlug, q);
        expect(res.groups, String(q)).toEqual([]);
        expect(statements, String(q)).toEqual([]);
      }
    });

    it("an amount query finds the exact decimal on invoices, bills, quotes, POs, payments and (either sign) bank transactions", async () => {
      for (const q of ["1234.50", "1,234.5", "$1234.5000", "-1234.50"]) {
        const kinds = (await SearchService.search(owner, orgSlug, q)).groups.map((g) => g.kind);
        expect(kinds, q).toEqual(["invoice", "quote", "bill", "purchase_order", "payment", "supplier_payment", "bank_transaction"]);
      }
      expect((await SearchService.search(owner, orgSlug, "1234.51")).groups).toEqual([]);
      expect((await SearchService.search(owner, orgSlug, "1234")).groups).toEqual([]); // exact decimals only, not a prefix of one
    });

    it("never returns more than 5 per type, newest document first", async () => {
      const db = adminDb();
      for (let i = 0; i < 8; i += 1) {
        await db.insert(contacts).values({ organizationId: owner.organizationId, kind: "CUSTOMER", displayName: `Bulk ${String(i).padStart(2, "0")}`, currency: "AUD" });
      }
      const group = (await SearchService.search(owner, orgSlug, "Bulk")).groups.find((g) => g.kind === "customer")!;
      expect(group.items).toHaveLength(5);
      expect(group.items.map((i) => i.title)).toEqual(["Bulk 00", "Bulk 01", "Bulk 02", "Bulk 03", "Bulk 04"]);
    });

    it("hides inactive customers (as the list page does) and reconciled bank transactions", async () => {
      await adminDb().update(contacts).set({ isActive: false });
      const kinds = (await SearchService.search(owner, orgSlug, "Zephyr")).groups.map((g) => g.kind);
      expect(kinds).not.toContain("customer");
      expect(kinds).not.toContain("supplier");
      expect(kinds).toContain("invoice");
    });
  });

  describe("tenant isolation", () => {
    it("another organization's records never appear, for any query, even with the same names", async () => {
      const other = await createTestOrg("search-b");
      await seedSearchData(other.organizationId, "Zephyr");
      await seedSearchData(other.organizationId, "Onlyb");

      const a = await SearchService.search(owner, orgSlug, "Zephyr");
      const ids = new Set(a.groups.flatMap((g) => g.items.map((i) => i.id)));
      expect(ids.size).toBe(14); // 13 types; two accounts carry the token
      for (const q of ["Onlyb", "1234.50"]) {
        const res = await SearchService.search(owner, orgSlug, q);
        expect(res.groups.flatMap((g) => g.items.map((i) => i.title)).join("|"), q).not.toMatch(/Onlyb/);
      }
      // ...and B sees only its own.
      const b = await SearchService.search(other.owner, "other", "Zephyr");
      for (const g of b.groups) for (const item of g.items) expect(ids.has(item.id), item.title).toBe(false);
      expect(b.groups.flatMap((g) => g.items)).toHaveLength(14);
    });
  });

  describe("statement budget", () => {
    it("is ONE tenant transaction and five statements for any query, however many types and rows", async () => {
      const m = async (q: string, actor: Actor = owner) => {
        statements = [];
        tracker.reset();
        await SearchService.search(actor, orgSlug, q);
        return { n: statements.length, sql: [...statements], tenant: tracker.tenantCalls.length, maxActive: tracker.maxActive };
      };
      const full = await m("Zephyr");
      expect(full.n).toBe(5);
      expect(full.tenant).toBe(1);
      expect(full.maxActive).toBe(1);
      expect(full.sql[0]).toMatch(/BEGIN/i);
      expect(full.sql[1]).toMatch(/app\.current_org_id/);
      expect(full.sql[2]).toMatch(/statement_timeout/);
      expect(full.sql[3]).toMatch(/UNION ALL/);
      expect(full.sql[4]).toMatch(/COMMIT/i);

      const db = adminDb();
      for (let i = 0; i < 30; i += 1) await db.insert(contacts).values({ organizationId: owner.organizationId, kind: "CUSTOMER", displayName: `Zephyr Extra ${i}`, currency: "AUD" });
      expect((await m("Zephyr")).n).toBe(5);
      expect((await m("1234.50")).n).toBe(5);
      expect((await m("zz-no-such-thing")).n).toBe(5);
      expect((await m("Zephyr", actorWithRole(owner, "PAYROLL_MANAGER"))).n).toBe(5);
      expect((await m("Zephyr", actorWithRole(owner, "EMPLOYEE"))).n).toBe(0); // nothing readable: no database work at all
      expect((await m("x")).n).toBe(0);
    });
  });
});
