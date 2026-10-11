import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { actorWithRole, addTestMember, closeTestPools, createTestOrg, pgMessage, resetDatabase } from "../../helpers/db";
import { db } from "@/db/client";
import { API_SCOPES, SCOPE_INFO, effectivePermissions, isForbiddenForApi } from "@/domain/api/scopes";
import { accounts, auditLogs, contacts, migrationBatches, migrationRows } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { PostingService } from "@/domain/ledger/posting-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import {
  DuplicateFileError,
  MigrationInputError,
  MigrationNotFoundError,
  MigrationService,
  MigrationStateError,
  RollbackBlockedError,
} from "@/domain/migration/migration-service";

const CHART = `Code,Name,Type
M100,Mig Bank,Bank
M200,Mig Payable,Accounts Payable
M400,Mig Sales,Income
M500,Mig Rent,Expense
`;
const CHART_BAD = `Code,Name,Type
M100,Mig Bank,Bank
M999,Broken,Wibble
`;

describe("migration engine: chart of accounts and contacts", () => {
  afterAll(closeTestPools);
  let owner: Actor;
  let orgId: string;
  let other: Actor;

  beforeEach(async () => {
    await resetDatabase();
    const a = await createTestOrg("mig-a");
    const b = await createTestOrg("mig-b");
    owner = a.owner;
    orgId = a.organizationId;
    other = b.owner;
  });

  const acct = (code: string) => withTenant(orgId, async (tx) => (await tx.select().from(accounts).where(eq(accounts.code, code)))[0]);

  it("stages without touching the books, then imports, and a re-run changes nothing", async () => {
    const staged = await MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", fileName: "coa.csv", text: CHART });
    expect(staged).toMatchObject({ rowCount: 4, validCount: 4, errorCount: 0 });
    expect(await acct("M100")).toBeUndefined();

    const done = await MigrationService.importBatch(owner, staged.batchId);
    expect(done).toMatchObject({ created: 4, skipped: 0 });
    expect(await acct("M100")).toMatchObject({ name: "Mig Bank", type: "ASSET", currency: "AUD", isActive: true });
    expect((await acct("M200"))!.type).toBe("LIABILITY");

    await expect(MigrationService.importBatch(owner, staged.batchId)).rejects.toBeInstanceOf(MigrationStateError);
    await expect(MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: CHART })).rejects.toBeInstanceOf(DuplicateFileError);
    const count = await withTenant(orgId, async (tx) => (await tx.select().from(accounts).where(eq(accounts.code, "M100"))).length);
    expect(count).toBe(1);
  });

  it("refuses a file with bad rows unless asked to skip them, and exports the errors safely", async () => {
    const staged = await MigrationService.stage(owner, {
      kind: "CHART_OF_ACCOUNTS",
      text: `Code,Name,Type\nM100,Mig Bank,Bank\nM999,=HYPERLINK("http://evil"),Wibble\n`,
    });
    expect(staged).toMatchObject({ validCount: 1, errorCount: 1 });
    await expect(MigrationService.importBatch(owner, staged.batchId)).rejects.toThrow(/problems/);
    expect(await acct("M100")).toBeUndefined();
    const csv = await MigrationService.errorsCsv(owner, staged.batchId);
    expect(csv).toContain("not one Money Matters recognises");
    expect(csv).toContain(`'=HYPERLINK`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);

    const done = await MigrationService.importBatch(owner, staged.batchId, { skipErrorRows: true });
    expect(done).toMatchObject({ created: 1, errorsSkipped: 1 });
    expect(await acct("M999")).toBeUndefined();
  });

  it("is resumable: rows already imported are not repeated after a failure", async () => {
    const staged = await MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: CHART });
    // Simulate a crash after part of the batch: one row already imported, batch FAILED.
    const first = await withTenant(orgId, async (tx) => (await tx.select().from(migrationRows).where(eq(migrationRows.batchId, staged.batchId)))[0]!);
    const created = await withTenant(orgId, async (tx) => {
      const [a] = await tx.insert(accounts).values({ organizationId: orgId, code: "M100", name: "Mig Bank", type: "ASSET", currency: "AUD" }).returning();
      await tx.update(migrationRows).set({ status: "IMPORTED", entityType: "Account", entityId: a!.id, entityAction: "CREATED" }).where(eq(migrationRows.id, first.id));
      await tx.update(migrationBatches).set({ status: "FAILED" }).where(eq(migrationBatches.id, staged.batchId));
      return a!;
    });
    const done = await MigrationService.importBatch(owner, staged.batchId);
    expect(done.created).toBe(4);
    expect((await acct("M100"))!.id).toBe(created.id);
  });

  it("treats an account that already exists as a link, never an overwrite", async () => {
    await withTenant(orgId, (tx) => tx.insert(accounts).values({ organizationId: orgId, code: "M400", name: "My own sales", type: "REVENUE", currency: "AUD" }));
    const staged = await MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: CHART });
    expect(staged).toMatchObject({ validCount: 3, errorCount: 0 });
    const done = await MigrationService.importBatch(owner, staged.batchId);
    expect(done).toMatchObject({ created: 3, skipped: 1 });
    expect((await acct("M400"))!.name).toBe("My own sales");
  });

  it("rolls back created accounts by deactivating them, refuses when one is in use, and allows a clean re-import", async () => {
    const staged = await MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: CHART });
    await MigrationService.importBatch(owner, staged.batchId);

    await expect(MigrationService.rollback(owner, staged.batchId, { confirm: "yes" })).rejects.toBeInstanceOf(MigrationInputError);

    const bank = (await acct("M100"))!;
    const sales = (await acct("M400"))!;
    await PostingService.postJournal(owner, {
      postingDate: new Date(),
      memo: "uses a migrated account",
      lines: [
        { accountId: bank.id, debit: "10.00", currency: "AUD" },
        { accountId: sales.id, credit: "10.00", currency: "AUD" },
      ],
    });
    const blocked = await MigrationService.rollback(owner, staged.batchId, { confirm: "ROLLBACK" }).catch((e) => e);
    expect(blocked).toBeInstanceOf(RollbackBlockedError);
    expect(blocked.message).toContain("M100");
    expect((await acct("M200"))!.isActive).toBe(true); // all-or-nothing: nothing was changed

    // A second batch whose accounts are unused rolls back cleanly and can be re-imported.
    const second = await MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: "Code,Name,Type\nR1,Spare,Expense\n" });
    await MigrationService.importBatch(owner, second.batchId);
    expect(await MigrationService.rollback(owner, second.batchId, { confirm: "ROLLBACK" })).toMatchObject({ deactivated: 1 });
    expect((await acct("R1"))!.isActive).toBe(false);
    await expect(MigrationService.rollback(owner, second.batchId, { confirm: "ROLLBACK" })).rejects.toBeInstanceOf(MigrationStateError);

    const again = await MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: "Code,Name,Type\nR1,Spare,Expense\n" });
    expect(again.validCount).toBe(1);
    await MigrationService.importBatch(owner, again.batchId);
    expect((await acct("R1"))!.isActive).toBe(true);
  });

  it("imports contacts with addresses, links existing names, and rolls back unused ones", async () => {
    await withTenant(orgId, (tx) => tx.insert(contacts).values({ organizationId: orgId, kind: "CUSTOMER", displayName: "Existing Co", currency: "AUD" }));
    const text = `Contact Name,Email Address,Address,City,Postcode\nExisting Co,,1 A St,X,1\nNew Co,new@example.com,2 B St,Sydney,2000\n`;
    await expect(MigrationService.stage(owner, { kind: "CONTACTS", text })).rejects.toThrow(/customers, suppliers or both/);
    const staged = await MigrationService.stage(owner, { kind: "CONTACTS", text, options: { defaultContactKind: "SUPPLIER" } });
    expect(staged).toMatchObject({ validCount: 1, duplicateCount: 1 });
    await MigrationService.importBatch(owner, staged.batchId);
    const created = await withTenant(orgId, async (tx) => (await tx.select().from(contacts).where(eq(contacts.displayName, "New Co")))[0]!);
    expect(created).toMatchObject({ kind: "SUPPLIER", email: "new@example.com" });
    expect(created.billingAddress).toMatchObject({ line1: "2 B St", city: "Sydney", postcode: "2000" });

    await MigrationService.rollback(owner, staged.batchId, { confirm: "ROLLBACK" });
    const after = await withTenant(orgId, async (tx) => tx.select().from(contacts));
    expect(after.find((c) => c.displayName === "New Co")!.isActive).toBe(false);
    expect(after.find((c) => c.displayName === "Existing Co")!.isActive).toBe(true);
  });

  it("is human-only, permission-gated and tenant-isolated", async () => {
    for (const role of ["OWNER", "ADMINISTRATOR", "ACCOUNTANT"] as const) expect(roleHasPermission(role, "migration:manage")).toBe(true);
    for (const role of ["BOOKKEEPER", "ACCOUNTS_RECEIVABLE", "ACCOUNTS_PAYABLE", "PAYROLL_MANAGER", "MANAGER", "EMPLOYEE", "READ_ONLY"] as const) {
      expect(roleHasPermission(role, "migration:manage"), role).toBe(false);
    }
    const bookkeeper = await addTestMember(owner, "BOOKKEEPER");
    await expect(MigrationService.stage(bookkeeper, { kind: "CHART_OF_ACCOUNTS", text: CHART })).rejects.toBeInstanceOf(PermissionDeniedError);
    for (const type of ["API", "AI", "AUTOMATION"] as const) {
      await expect(MigrationService.stage({ ...owner, type }, { kind: "CHART_OF_ACCOUNTS", text: CHART })).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    const accountant = actorWithRole(owner, "ACCOUNTANT");
    const staged = await MigrationService.stage(accountant, { kind: "CHART_OF_ACCOUNTS", text: CHART });

    await expect(MigrationService.get(other, staged.batchId)).rejects.toBeInstanceOf(MigrationNotFoundError);
    await expect(MigrationService.importBatch(other, staged.batchId)).rejects.toBeInstanceOf(MigrationNotFoundError);
    expect(await MigrationService.list(other)).toHaveLength(0);
    // The same file is not a "duplicate" in a different company.
    await expect(MigrationService.stage(other, { kind: "CHART_OF_ACCOUNTS", text: CHART })).resolves.toBeTruthy();
  });

  it("audits stage, import and rollback, and discard works only before import", async () => {
    const staged = await MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: CHART });
    await MigrationService.importBatch(owner, staged.batchId);
    await MigrationService.rollback(owner, staged.batchId, { confirm: "ROLLBACK" });
    const actions = await withTenant(orgId, async (tx) => (await tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, staged.batchId))).map((r) => r.action));
    expect(actions.sort()).toEqual(["migration.imported", "migration.rolled_back", "migration.staged"]);

    const s2 = await MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: CHART_BAD });
    await MigrationService.discard(owner, s2.batchId);
    await expect(MigrationService.importBatch(owner, s2.batchId)).rejects.toBeInstanceOf(MigrationStateError);
    await expect(MigrationService.discard(owner, staged.batchId)).rejects.toBeInstanceOf(MigrationStateError);
    const stillThere = await withTenant(orgId, async (tx) => tx.select().from(migrationRows).where(and(eq(migrationRows.batchId, s2.batchId))));
    expect(stillThere).toHaveLength(2);
  });

  it("is unreachable from the public API and enforced by row-level security", async () => {
    expect(isForbiddenForApi("migration:manage")).toBe(true);
    for (const scope of API_SCOPES) expect(SCOPE_INFO[scope].permissions).not.toContain("migration:manage");
    expect(effectivePermissions(["migration:manage", "*"], "OWNER").has("migration:manage")).toBe(false);

    const staged = await MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: CHART });
    // No tenant context: the app role sees nothing, and cannot write a row into another company.
    expect(await db.select().from(migrationBatches)).toHaveLength(0);
    expect(await db.select().from(migrationRows)).toHaveLength(0);
    const msg = await pgMessage(
      withTenant(other.organizationId, (tx) =>
        tx.insert(migrationRows).values({ organizationId: orgId, batchId: staged.batchId, rowNumber: 99, raw: {}, status: "VALID" }),
      ),
    );
    expect(msg).toMatch(/row-level security|violates/);
    const del = await pgMessage(withTenant(orgId, (tx) => tx.delete(migrationBatches)));
    expect(del).toMatch(/permission denied/);
  });

  it("rejects hostile files cleanly", async () => {
    await expect(MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: "" })).rejects.toBeInstanceOf(MigrationInputError);
    await expect(MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: "PK\u0003\u0004\u0000\u0000binary" })).rejects.toBeInstanceOf(MigrationInputError);
    await expect(MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: "a,b\n1,2" })).rejects.toThrow(/Map a column/);
    await expect(MigrationService.stage(owner, { kind: "NOPE" as never, text: CHART })).rejects.toBeInstanceOf(MigrationInputError);
    await expect(
      MigrationService.stage(owner, { kind: "CHART_OF_ACCOUNTS", text: CHART, mapping: { code: "Code", name: "Name", type: "Nope" } }),
    ).rejects.toThrow(/not in the file/);
  });
});
