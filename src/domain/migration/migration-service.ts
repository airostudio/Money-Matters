import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { accounts, contacts, migrationBatches, migrationRows, organizations } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { AccountService } from "@/domain/accounts/account-service";
import { ContactService } from "@/domain/contacts/contact-service";
import { assertPermission, PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { CsvError, parseCsv, toCsv } from "./csv";
import { FIELDS, isMigrationKind, mappingProblem, suggestMapping, type MigrationKind } from "./fields";
import { DATE_FORMATS } from "./normalize";
import { validateRowsFor, type MigrationOptions, type RawRow, type StagedRow, type ValidationContext } from "./validators";

/**
 * The migration engine's service layer. Three phases, each explicit:
 *
 *  1. STAGE   - parse the CSV, confirm the column mapping, validate EVERY row, store the rows. Nothing touches the books.
 *  2. IMPORT  - on a human's confirmation, write the valid rows in small bounded transactions. Resumable: each row records
 *               what it created the moment it is created, and a re-run only processes rows still VALID.
 *  3. ROLLBACK - undo an import, but only when every record it created is still unused (all-or-nothing, typed confirmation).
 *
 * Human-only: `migration:manage` plus a HUMAN actor. An API key, AI agent or automation can never run an import.
 */

export class MigrationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationInputError";
  }
}
export class MigrationNotFoundError extends Error {
  constructor() {
    super("That import was not found in this company.");
    this.name = "MigrationNotFoundError";
  }
}
export class DuplicateFileError extends Error {
  constructor(public readonly batchId: string) {
    super("This exact file has already been uploaded and its import is still live. Open the existing import instead, or roll it back first.");
    this.name = "DuplicateFileError";
  }
}
export class MigrationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationStateError";
  }
}
export class RollbackBlockedError extends Error {
  constructor(public readonly blockers: string[]) {
    super(`This import cannot be rolled back because ${blockers.length} record${blockers.length === 1 ? " is" : "s are"} already in use: ${blockers.slice(0, 10).join(", ")}${blockers.length > 10 ? ", ..." : ""}. Nothing was changed.`);
    this.name = "RollbackBlockedError";
  }
}

export const ROLLBACK_CONFIRMATION = "ROLLBACK";
const IMPORT_CHUNK = 200;
const INSERT_CHUNK = 500;

function assertManager(actor: Actor): void {
  assertPermission(actor, "migration:manage");
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError("migration:manage", actor.role);
}

export interface StageInput {
  kind: MigrationKind;
  fileName?: string | null;
  text: string;
  /** Target field -> source column. Omitted: the deterministic suggestion. */
  mapping?: Record<string, string>;
  options?: MigrationOptions;
}

export interface StageResult {
  batchId: string;
  rowCount: number;
  validCount: number;
  errorCount: number;
  duplicateCount: number;
  mapping: Record<string, string>;
}

function cleanOptions(kind: MigrationKind, raw: MigrationOptions | undefined): MigrationOptions {
  const o: MigrationOptions = {};
  const src = raw ?? {};
  if (src.dateFormat !== undefined) {
    if (!(DATE_FORMATS as readonly string[]).includes(src.dateFormat)) throw new MigrationInputError("Choose a date format.");
    o.dateFormat = src.dateFormat;
  }
  if (src.decimalComma !== undefined) o.decimalComma = Boolean(src.decimalComma);
  if (kind === "CONTACTS") {
    if (src.defaultContactKind !== undefined) {
      if (!["CUSTOMER", "SUPPLIER", "BOTH"].includes(src.defaultContactKind)) throw new MigrationInputError("Choose customers, suppliers or both.");
      o.defaultContactKind = src.defaultContactKind;
    }
  }
  if (kind === "CHART_OF_ACCOUNTS" && src.accountTypeMap) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(src.accountTypeMap).slice(0, 200)) map[k.trim().toLowerCase().replace(/\s+/g, " ")] = String(v).toUpperCase();
    o.accountTypeMap = map;
  }
  return o;
}

function toRawRows(headers: string[], rows: string[][]): RawRow[] {
  return rows.map((cells, i) => ({
    rowNumber: i + 2, // 1-based, with the heading row as row 1, so it matches the spreadsheet
    cells: Object.fromEntries(headers.map((h, c) => [h, cells[c] ?? ""])),
  }));
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

async function loadBatch(tx: TenantDb, actor: Actor, batchId: string) {
  const [batch] = await tx
    .select()
    .from(migrationBatches)
    .where(and(eq(migrationBatches.id, batchId), eq(migrationBatches.organizationId, actor.organizationId)));
  if (!batch) throw new MigrationNotFoundError();
  return batch;
}

export const MigrationService = {
  /** Suggested mapping for a file, without staging anything (drives the mapping screen's pre-fill). */
  preview(actor: Actor, input: { kind: MigrationKind; text: string }) {
    assertManager(actor);
    try {
      const parsed = parseCsv(input.text);
      return {
        headers: parsed.headers,
        sampleRows: parsed.rows.slice(0, 5),
        rowCount: parsed.rows.length,
        suggestedMapping: suggestMapping(input.kind, parsed.headers),
        fields: FIELDS[input.kind],
      };
    } catch (error) {
      if (error instanceof CsvError) throw new MigrationInputError(error.message);
      throw error;
    }
  },

  async stage(actor: Actor, input: StageInput): Promise<StageResult> {
    assertManager(actor);
    if (!isMigrationKind(input.kind)) throw new MigrationInputError("Choose what you are importing.");
    let parsed;
    try {
      parsed = parseCsv(input.text);
    } catch (error) {
      if (error instanceof CsvError) throw new MigrationInputError(error.message);
      throw error;
    }
    const mapping = input.mapping ?? suggestMapping(input.kind, parsed.headers);
    const problem = mappingProblem(input.kind, parsed.headers, mapping);
    if (problem) throw new MigrationInputError(problem);
    const options = cleanOptions(input.kind, input.options);
    if (input.kind === "CONTACTS" && !mapping.kind && !options.defaultContactKind) {
      throw new MigrationInputError("Say whether these are customers, suppliers or both (this file has no column for it).");
    }
    const fileHash = createHash("sha256").update(input.text, "utf8").digest("hex");
    const rawRows = toRawRows(parsed.headers, parsed.rows);
    const fileName = input.fileName ? input.fileName.replace(/[\u0000-\u001f]/g, "").slice(0, 200) : null;

    try {
      return await withTenant(actor.organizationId, async (tx) => {
        const [dupe] = await tx
          .select({ id: migrationBatches.id })
          .from(migrationBatches)
          .where(
            and(
              eq(migrationBatches.organizationId, actor.organizationId),
              eq(migrationBatches.kind, input.kind),
              eq(migrationBatches.fileHash, fileHash),
              inArray(migrationBatches.status, ["STAGED", "IMPORTING", "IMPORTED", "FAILED"]),
            ),
          );
        if (dupe) throw new DuplicateFileError(dupe.id);

        const [org] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, actor.organizationId));
        const allAccounts = await tx.select({ id: accounts.id, code: accounts.code, name: accounts.name, isActive: accounts.isActive }).from(accounts).where(eq(accounts.organizationId, actor.organizationId));
        const allContacts = await tx.select({ id: contacts.id, name: contacts.displayName, isActive: contacts.isActive }).from(contacts).where(eq(contacts.organizationId, actor.organizationId));
        // An inactive record left behind by a rolled-back import is revived on re-import, so it does not count as existing.
        const revived = await revivable(tx, [...allAccounts, ...allContacts].filter((r) => !r.isActive).map((r) => r.id));
        const existingAccounts = allAccounts.filter((a) => !revived.has(a.id));
        const existingContacts = allContacts.filter((c) => !revived.has(c.id));
        const ctx: ValidationContext = {
          baseCurrency: org?.baseCurrency ?? "AUD",
          existingAccountCodes: new Map(existingAccounts.map((a) => [a.code, a.name])),
          existingContactNames: new Set(existingContacts.map((c) => c.name.toLowerCase())),
        };
        const staged = validateRowsFor(input.kind, rawRows, mapping, options, ctx);
        const counts = countStatuses(staged);

        const [batch] = await tx
          .insert(migrationBatches)
          .values({
            organizationId: actor.organizationId,
            kind: input.kind,
            status: "STAGED",
            fileName,
            fileHash,
            mapping,
            options,
            rowCount: staged.length,
            errorCount: counts.error,
            skippedCount: counts.duplicate,
            createdById: actor.userId,
          })
          .returning({ id: migrationBatches.id });
        if (!batch) throw new Error("Failed to record the import.");

        for (let i = 0; i < staged.length; i += INSERT_CHUNK) {
          await tx.insert(migrationRows).values(
            staged.slice(i, i + INSERT_CHUNK).map((r) => ({
              organizationId: actor.organizationId,
              batchId: batch.id,
              rowNumber: r.rowNumber,
              raw: r.raw,
              normalized: r.normalized,
              naturalKey: r.naturalKey,
              status: r.status,
              errors: r.messages.length ? r.messages : null,
            })),
          );
        }

        await AuditService.record(tx, actor, {
          action: "migration.staged",
          entityType: "MigrationBatch",
          entityId: batch.id,
          after: { kind: input.kind, fileName, fileHash, rowCount: staged.length, errorCount: counts.error, duplicateCount: counts.duplicate },
        });

        return { batchId: batch.id, rowCount: staged.length, validCount: counts.valid, errorCount: counts.error, duplicateCount: counts.duplicate, mapping };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateFileError("");
      throw error;
    }
  },

  async list(actor: Actor) {
    assertManager(actor);
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(migrationBatches)
        .where(eq(migrationBatches.organizationId, actor.organizationId))
        .orderBy(desc(migrationBatches.createdAt))
        .limit(200),
    );
  },

  async get(actor: Actor, batchId: string, opts: { status?: string; offset?: number; limit?: number } = {}) {
    assertManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const batch = await loadBatch(tx, actor, batchId);
      const where = and(
        eq(migrationRows.batchId, batchId),
        eq(migrationRows.organizationId, actor.organizationId),
        opts.status ? eq(migrationRows.status, opts.status) : undefined,
      );
      const rows = await tx
        .select()
        .from(migrationRows)
        .where(where)
        .orderBy(asc(migrationRows.rowNumber))
        .offset(Math.max(0, opts.offset ?? 0))
        .limit(Math.min(500, opts.limit ?? 100));
      const statusCounts = await tx
        .select({ status: migrationRows.status, n: sql<number>`count(*)::int` })
        .from(migrationRows)
        .where(and(eq(migrationRows.batchId, batchId), eq(migrationRows.organizationId, actor.organizationId)))
        .groupBy(migrationRows.status);
      return { batch, rows, statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s.n])) as Record<string, number> };
    });
  },

  /** A CSV of the rows that failed validation, with the reason, for fixing the source file. Cells are formula-neutralised. */
  async errorsCsv(actor: Actor, batchId: string): Promise<string> {
    assertManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      await loadBatch(tx, actor, batchId);
      const rows = await tx
        .select()
        .from(migrationRows)
        .where(and(eq(migrationRows.batchId, batchId), eq(migrationRows.organizationId, actor.organizationId), eq(migrationRows.status, "ERROR")))
        .orderBy(asc(migrationRows.rowNumber))
        .limit(20_000);
      const headers = rows[0] ? Object.keys(rows[0].raw as Record<string, string>) : [];
      return toCsv(
        ["Row", "Problems", ...headers],
        rows.map((r) => [r.rowNumber, ((r.errors as string[] | null) ?? []).join(" | "), ...headers.map((h) => (r.raw as Record<string, string>)[h] ?? "")]),
      );
    });
  },

  async discard(actor: Actor, batchId: string): Promise<void> {
    assertManager(actor);
    await withTenant(actor.organizationId, async (tx) => {
      const [updated] = await tx
        .update(migrationBatches)
        .set({ status: "DISCARDED" })
        .where(and(eq(migrationBatches.id, batchId), eq(migrationBatches.organizationId, actor.organizationId), inArray(migrationBatches.status, ["STAGED", "FAILED"])))
        .returning({ id: migrationBatches.id });
      if (!updated) {
        await loadBatch(tx, actor, batchId);
        throw new MigrationStateError("Only an import that has not finished can be discarded. Use roll back for a finished one.");
      }
      await AuditService.record(tx, actor, { action: "migration.discarded", entityType: "MigrationBatch", entityId: batchId });
    });
  },

  /**
   * Writes the batch's VALID rows. Refuses a file with error rows unless the caller explicitly chose to skip them. Safe to
   * call again after a failure: rows already imported are never touched twice.
   */
  async importBatch(actor: Actor, batchId: string, opts: { skipErrorRows?: boolean } = {}) {
    assertManager(actor);
    const claimed = await withTenant(actor.organizationId, async (tx) => {
      const batch = await loadBatch(tx, actor, batchId);
      if (!["STAGED", "FAILED"].includes(batch.status)) {
        throw new MigrationStateError(batch.status === "IMPORTED" ? "This import has already been completed." : `This import is ${batch.status.toLowerCase().replace("_", " ")} and cannot be started.`);
      }
      if (batch.errorCount > 0 && !opts.skipErrorRows) {
        throw new MigrationStateError(`${batch.errorCount} row${batch.errorCount === 1 ? " has" : "s have"} problems. Fix the file and upload it again, or choose to skip those rows.`);
      }
      const [row] = await tx
        .update(migrationBatches)
        .set({ status: "IMPORTING" })
        .where(and(eq(migrationBatches.id, batchId), eq(migrationBatches.organizationId, actor.organizationId), inArray(migrationBatches.status, ["STAGED", "FAILED"])))
        .returning();
      if (!row) throw new MigrationStateError("Another import of this file started first.");
      return row;
    });

    try {
      for (;;) {
        const done = await withTenant(actor.organizationId, async (tx) => {
          const rows = await tx
            .select()
            .from(migrationRows)
            .where(and(eq(migrationRows.batchId, batchId), eq(migrationRows.organizationId, actor.organizationId), eq(migrationRows.status, "VALID")))
            .orderBy(asc(migrationRows.rowNumber))
            .limit(IMPORT_CHUNK);
          if (rows.length === 0) return true;
          if (claimed.kind === "CHART_OF_ACCOUNTS") await importAccountRows(tx, actor, rows);
          else if (claimed.kind === "CONTACTS") await importContactRows(tx, actor, rows);
          else throw new MigrationStateError(`Importing ${claimed.kind} is not available yet.`);
          return false;
        });
        if (done) break;
      }
      return await withTenant(actor.organizationId, async (tx) => {
        const grouped = await tx
          .select({ status: migrationRows.status, action: migrationRows.entityAction, n: sql<number>`count(*)::int` })
          .from(migrationRows)
          .where(and(eq(migrationRows.batchId, batchId), eq(migrationRows.organizationId, actor.organizationId)))
          .groupBy(migrationRows.status, migrationRows.entityAction);
        const n = (status: string, action?: string | null) => grouped.filter((g) => g.status === status && (action === undefined || g.action === action)).reduce((a, g) => a + g.n, 0);
        const created = n("IMPORTED", "CREATED");
        const result = { created, skipped: n("SKIPPED_DUPLICATE"), errorsSkipped: n("ERROR") };
        await tx
          .update(migrationBatches)
          .set({ status: "IMPORTED", importedAt: new Date(), importedCount: created, skippedCount: result.skipped, result })
          .where(eq(migrationBatches.id, batchId));
        await AuditService.record(tx, actor, { action: "migration.imported", entityType: "MigrationBatch", entityId: batchId, after: { kind: claimed.kind, ...result } });
        return { batchId, ...result };
      });
    } catch (error) {
      await withTenant(actor.organizationId, (tx) =>
        tx.update(migrationBatches).set({ status: "FAILED" }).where(and(eq(migrationBatches.id, batchId), eq(migrationBatches.status, "IMPORTING"))),
      );
      throw error;
    }
  },

  /**
   * Undoes an IMPORTED batch: records it CREATED are deactivated (never deleted), records it only matched are left alone.
   * All-or-nothing: if any created record has since been used (an account with journal lines, a contact with invoices, ...)
   * nothing changes and the blockers are named.
   */
  async rollback(actor: Actor, batchId: string, opts: { confirm: string }) {
    assertManager(actor);
    if (opts.confirm !== ROLLBACK_CONFIRMATION) throw new MigrationInputError(`Type ${ROLLBACK_CONFIRMATION} to confirm.`);
    return withTenant(actor.organizationId, async (tx) => {
      const locked = await tx.execute(sql`SELECT status FROM migration_batches WHERE id = ${batchId} AND organization_id = ${actor.organizationId} FOR UPDATE`);
      if (locked.rows.length === 0) throw new MigrationNotFoundError();
      const batch = await loadBatch(tx, actor, batchId);
      if (batch.status !== "IMPORTED") throw new MigrationStateError("Only a completed import can be rolled back.");
      const rows = await tx
        .select()
        .from(migrationRows)
        .where(and(eq(migrationRows.batchId, batchId), eq(migrationRows.organizationId, actor.organizationId), eq(migrationRows.status, "IMPORTED"), eq(migrationRows.entityAction, "CREATED")));

      const blockers: string[] = [];
      for (const [entityType, table, label] of [["Account", "accounts", "account"], ["Contact", "contacts", "contact"]] as const) {
        const ids = rows.filter((r) => r.entityType === entityType && r.entityId).map((r) => r.entityId!);
        if (ids.length === 0) continue;
        const inUse = await referencedIds(tx, table, ids);
        for (const r of rows) if (r.entityType === entityType && r.entityId && inUse.has(r.entityId)) blockers.push(`${label} "${labelOf(r)}"`);
      }
      if (blockers.length > 0) throw new RollbackBlockedError(blockers);

      const accountIds = rows.filter((r) => r.entityType === "Account").map((r) => r.entityId!);
      const contactIds = rows.filter((r) => r.entityType === "Contact").map((r) => r.entityId!);
      const now = new Date();
      for (let i = 0; i < accountIds.length; i += INSERT_CHUNK) {
        await tx.update(accounts).set({ isActive: false, updatedAt: now, updatedById: actor.userId }).where(and(eq(accounts.organizationId, actor.organizationId), inArray(accounts.id, accountIds.slice(i, i + INSERT_CHUNK))));
      }
      for (let i = 0; i < contactIds.length; i += INSERT_CHUNK) {
        await tx.update(contacts).set({ isActive: false, updatedAt: now, updatedById: actor.userId }).where(and(eq(contacts.organizationId, actor.organizationId), inArray(contacts.id, contactIds.slice(i, i + INSERT_CHUNK))));
      }
      await tx
        .update(migrationRows)
        .set({ status: "ROLLED_BACK" })
        .where(and(eq(migrationRows.batchId, batchId), eq(migrationRows.organizationId, actor.organizationId), eq(migrationRows.status, "IMPORTED")));
      const result = { ...((batch.result as object | null) ?? {}), rolledBack: rows.length };
      await tx.update(migrationBatches).set({ status: "ROLLED_BACK", rolledBackAt: now, rolledBackById: actor.userId, result }).where(eq(migrationBatches.id, batchId));
      await AuditService.record(tx, actor, { action: "migration.rolled_back", entityType: "MigrationBatch", entityId: batchId, after: { kind: batch.kind, deactivated: rows.length } });
      return { batchId, deactivated: rows.length };
    });
  },
};

function countStatuses(rows: readonly StagedRow[]) {
  let valid = 0;
  let error = 0;
  let duplicate = 0;
  for (const r of rows) {
    if (r.status === "VALID") valid++;
    else if (r.status === "ERROR") error++;
    else duplicate++;
  }
  return { valid, error, duplicate };
}

/** Which of these ids does any other record point at (any readable foreign key to the table)? Found from the catalogue, so a new referencing table is covered automatically. */
async function referencedIds(tx: TenantDb, table: string, ids: string[]): Promise<Set<string>> {
  const fks = await tx.execute(sql`
    SELECT n.nspname AS schema, cl.relname AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.confrelid = ${table}::regclass AND array_length(c.conkey, 1) = 1
      AND has_table_privilege(c.conrelid, 'SELECT')
  `);
  const used = new Set<string>();
  for (const fk of fks.rows as { schema: string; tbl: string; col: string }[]) {
    const res = await tx.execute(
      sql`SELECT DISTINCT ${sql.identifier(fk.col)}::text AS id FROM ${sql.identifier(fk.schema)}.${sql.identifier(fk.tbl)} WHERE ${sql.identifier(fk.col)} IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`,
    );
    for (const r of res.rows as { id: string }[]) used.add(r.id);
  }
  return used;
}

/** Rows whose existing inactive record was created by an earlier, rolled-back import may be revived instead of skipped. */
async function revivable(tx: TenantDb, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ entityId: migrationRows.entityId })
    .from(migrationRows)
    .where(and(inArray(migrationRows.entityId, ids), eq(migrationRows.status, "ROLLED_BACK"), eq(migrationRows.entityAction, "CREATED")));
  return new Set(rows.map((r) => r.entityId!));
}

async function markRow(tx: TenantDb, rowId: string, patch: { status: string; entityType: string; entityId: string; entityAction: string }) {
  await tx.update(migrationRows).set(patch).where(eq(migrationRows.id, rowId));
}

type StagedDbRow = typeof migrationRows.$inferSelect;

function labelOf(row: StagedDbRow): string {
  const v = (row.normalized ?? {}) as { code?: string; name?: string; displayName?: string };
  return v.code ? `${v.code} ${v.name ?? ""}`.trim() : (v.displayName ?? row.naturalKey ?? row.entityId ?? "");
}

async function importAccountRows(tx: TenantDb, actor: Actor, rows: StagedDbRow[]) {
  const codes = rows.map((r) => (r.normalized as { code: string }).code);
  const existing = await tx.select().from(accounts).where(and(eq(accounts.organizationId, actor.organizationId), inArray(accounts.code, codes)));
  const byCode = new Map(existing.map((a) => [a.code, a]));
  const revive = await revivable(tx, existing.filter((a) => !a.isActive).map((a) => a.id));
  for (const row of rows) {
    const v = row.normalized as { code: string; name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE"; subType: string | null; description: string | null; currency: string };
    const found = byCode.get(v.code);
    if (found) {
      if (!found.isActive && revive.has(found.id)) {
        await tx.update(accounts).set({ isActive: true, updatedAt: new Date(), updatedById: actor.userId }).where(eq(accounts.id, found.id));
        await markRow(tx, row.id, { status: "IMPORTED", entityType: "Account", entityId: found.id, entityAction: "CREATED" });
      } else {
        await markRow(tx, row.id, { status: "SKIPPED_DUPLICATE", entityType: "Account", entityId: found.id, entityAction: "LINKED" });
      }
      continue;
    }
    const created = await AccountService.createIn(tx, actor, {
      code: v.code,
      name: v.name,
      type: v.type,
      currency: v.currency,
      subType: v.subType ?? undefined,
      description: v.description ?? undefined,
    });
    await markRow(tx, row.id, { status: "IMPORTED", entityType: "Account", entityId: created.id, entityAction: "CREATED" });
  }
}

async function importContactRows(tx: TenantDb, actor: Actor, rows: StagedDbRow[]) {
  const names = rows.map((r) => (r.normalized as { displayName: string }).displayName.toLowerCase());
  const existing = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.organizationId, actor.organizationId), inArray(sql<string>`lower(${contacts.displayName})`, names)));
  const byName = new Map(existing.map((c) => [c.displayName.toLowerCase(), c]));
  const revive = await revivable(tx, existing.filter((c) => !c.isActive).map((c) => c.id));
  for (const row of rows) {
    const v = row.normalized as { displayName: string; kind: "CUSTOMER" | "SUPPLIER" | "BOTH"; legalName: string | null; email: string | null; phone: string | null; taxNumber: string | null; billingAddress: Record<string, unknown> | null; currency: string };
    const found = byName.get(v.displayName.toLowerCase());
    if (found) {
      if (!found.isActive && revive.has(found.id)) {
        await tx.update(contacts).set({ isActive: true, updatedAt: new Date(), updatedById: actor.userId }).where(eq(contacts.id, found.id));
        await markRow(tx, row.id, { status: "IMPORTED", entityType: "Contact", entityId: found.id, entityAction: "CREATED" });
      } else {
        await markRow(tx, row.id, { status: "SKIPPED_DUPLICATE", entityType: "Contact", entityId: found.id, entityAction: "LINKED" });
      }
      continue;
    }
    const created = await ContactService.createIn(tx, actor, {
      kind: v.kind,
      displayName: v.displayName,
      currency: v.currency,
      legalName: v.legalName ?? undefined,
      email: v.email ?? undefined,
      phone: v.phone ?? undefined,
      taxNumber: v.taxNumber ?? undefined,
      billingAddress: v.billingAddress ?? undefined,
    });
    await markRow(tx, row.id, { status: "IMPORTED", entityType: "Contact", entityId: created.id, entityAction: "CREATED" });
  }
}
