// Money Matters — Phase 1 (Financial Foundation) schema.
// See docs/database.md for conventions and docs/accounting-engine.md for the
// invariants the ledger tables must uphold. Plain PostgreSQL via Drizzle ORM
// — see docs/decisions/0001-database-orm.md for why Drizzle (not Prisma).

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  numeric,
  integer,
  jsonb,
  uniqueIndex,
  index,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/**
 * Raw binary storage for uploaded documents (receipts/invoices) —
 * `bytea` in Postgres. See docs/decisions/0007-document-storage-bytea.md
 * for why this is a deliberate, temporary choice pending real object
 * storage (S3/Vercel Blob) credentials.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const membershipRoleEnum = pgEnum("membership_role", [
  "OWNER",
  "ADMINISTRATOR",
  "ACCOUNTANT",
  "BOOKKEEPER",
  "PAYROLL_MANAGER",
  "ACCOUNTS_PAYABLE",
  "ACCOUNTS_RECEIVABLE",
  "MANAGER",
  "EMPLOYEE",
  "READ_ONLY",
]);

export const accountTypeEnum = pgEnum("account_type", [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "EXPENSE",
]);

export const fiscalPeriodStatusEnum = pgEnum("fiscal_period_status", [
  "OPEN",
  "SOFT_LOCKED",
  "HARD_LOCKED",
]);

export const contactKindEnum = pgEnum("contact_kind", ["CUSTOMER", "SUPPLIER", "BOTH"]);

export const journalEntryStatusEnum = pgEnum("journal_entry_status", [
  "DRAFT",
  "POSTED",
  "REVERSED",
]);

export const journalEntrySourceTypeEnum = pgEnum("journal_entry_source_type", [
  "MANUAL",
  "OPENING_BALANCE",
  "SYSTEM",
  "BANK_TRANSACTION",
]);

/**
 * "MANUAL" is the only provider implemented in Phase 2 — a person uploads a
 * CSV/OFX/QIF statement export. The column exists so a live feed provider
 * (Basiq, for AU open banking) can be added later without a schema change:
 * see docs/decisions/0006-bank-feed-abstraction.md.
 */
export const bankFeedProviderEnum = pgEnum("bank_feed_provider", ["MANUAL"]);

export const bankImportFormatEnum = pgEnum("bank_import_format", ["CSV", "OFX", "QIF"]);

export const bankTransactionStatusEnum = pgEnum("bank_transaction_status", [
  "UNMATCHED",
  "RECONCILED",
  "EXCLUDED",
]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export const auditActorTypeEnum = pgEnum("audit_actor_type", ["HUMAN", "AI", "SYSTEM"]);

/**
 * Phase 3 Slice 1 (Sales — customer invoicing & AR core). `DRAFT` has no
 * ledger effect and is fully editable/deletable, mirroring the journal
 * entry lifecycle in docs/accounting-engine.md §1. `APPROVED` means posted
 * to the ledger (debit AR / credit revenue+tax) via `PostingService` — see
 * `src/domain/sales/invoice-service.ts`. `SENT`/`VIEWED` are informational
 * only. `PART_PAID`/`PAID` are derived from `payment_allocations` and kept
 * in sync by `PaymentAllocationService`. `VOID` means the posting journal
 * was reversed (never edited) — see `InvoiceService.voidInvoice`.
 *
 * There is deliberately no stored `OVERDUE` value: "overdue" is a function
 * of `dueDate` vs. "now" for any unpaid invoice, computed at read time
 * (`InvoiceService.list`/`get`) rather than written by a background job —
 * Phase 2 Slice 2's job/queue infrastructure (see docs/roadmap.md) is what
 * a scheduled status flip would need, and isn't built yet.
 */
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "DRAFT",
  "APPROVED",
  "SENT",
  "VIEWED",
  "PART_PAID",
  "PAID",
  "VOID",
]);

export const paymentMethodEnum = pgEnum("payment_method", [
  "BANK_TRANSFER",
  "CASH",
  "CARD",
  "CHEQUE",
  "OTHER",
]);

/**
 * Phase 3 Slice 2 (Sales — quotes). A quote never touches the ledger — see
 * `src/domain/sales/quote-service.ts` — so unlike `invoice_status` there is
 * no APPROVED/posted state at all. `DRAFT` is fully editable. `SENT` is
 * informational. `ACCEPTED`/`DECLINED` are the customer's answer (recorded
 * by a human on the customer's behalf — there is no customer portal in this
 * slice, see docs/roadmap.md). `CONVERTED` is set once, when
 * `QuoteService.convertToInvoice` creates a draft invoice from an ACCEPTED
 * quote — the quote itself is never edited again after that. `EXPIRED` is
 * computed at read time from `expiryDate` vs. "now" for a quote still SENT,
 * the same deliberate choice as `invoice_status`'s missing OVERDUE value —
 * no background job infrastructure exists yet to flip it automatically.
 */
export const quoteStatusEnum = pgEnum("quote_status", [
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "DECLINED",
  "CONVERTED",
]);

/**
 * Phase 3 Slice 2 (Sales — recurring invoicing). How often a
 * `recurring_invoice_template` generates its next draft invoice — see
 * `src/domain/sales/recurring-invoice-service.ts` for the next-run-date
 * advancement logic per frequency.
 */
export const recurringFrequencyEnum = pgEnum("recurring_frequency", [
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "ANNUALLY",
]);

/**
 * Phase 4 Slice 1 (Purchases — supplier bills & AP core), the mirror image
 * of `invoice_status`. There is no SENT/VIEWED equivalent — a bill is
 * something the organization receives, not delivers — so a bill goes
 * straight from DRAFT to APPROVED (posted: debit expense/asset + tax input
 * credit, credit Accounts Payable) via `PostingService`. PART_PAID/PAID are
 * derived from `supplier_payment_allocations` and kept in sync by
 * `SupplierPaymentAllocationService`, never a stored counter. VOID means the
 * posting journal was reversed (never edited) — see
 * `src/domain/purchases/bill-service.ts`.
 */
export const billStatusEnum = pgEnum("bill_status", [
  "DRAFT",
  "APPROVED",
  "PART_PAID",
  "PAID",
  "VOID",
]);

/**
 * Phase 2 Slice 2 (expense management, master spec §19). `DRAFT` has no
 * ledger effect and is fully editable/deletable. `SUBMITTED` is a simple
 * single-approver gate (the tiered/segregated approval engine is Phase
 * 9/10 — out of scope here); an approver either `APPROVED`s it (which
 * posts: debit each line's expense/tax account, credit the "Employee
 * Reimbursements Payable" liability, via `PostingService`) or `REJECTED`s
 * it (no ledger effect). `REIMBURSED` means a second journal has moved the
 * payable to the paying bank/asset account — posting and payment are kept
 * separate the same way bills/invoices separate approval from payment.
 * `VOID` means a posted claim's journal was reversed (never edited), same
 * discipline as `bill_status`/`invoice_status`.
 */
export const expenseClaimStatusEnum = pgEnum("expense_claim_status", [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "REIMBURSED",
  "VOID",
]);

/**
 * Document AI extraction outcome for an uploaded receipt/invoice image or
 * PDF (master spec §17). `NOT_ATTEMPTED` covers both "no API key
 * configured" and "extraction hasn't run yet" — in both cases the upload
 * still succeeds and the user gets a blank draft to fill in manually.
 * `EXTRACTED` data is always a *suggestion*: nothing here is ever posted or
 * saved onto an expense claim/bill without a human reviewing and
 * confirming it first, per docs/ai-agents.md.
 */
export const documentExtractionStatusEnum = pgEnum("document_extraction_status", [
  "NOT_ATTEMPTED",
  "EXTRACTED",
  "FAILED",
]);

// ---------------------------------------------------------------------------
// Identity & tenancy
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  emailUnique: uniqueIndex("users_email_unique").on(table.email),
}));

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  baseCurrency: text("base_currency").notNull().default("AUD"),
  country: text("country").notNull().default("AU"),
  industry: text("industry"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  slugUnique: uniqueIndex("organizations_slug_unique").on(table.slug),
}));

export const organizationMemberships = pgTable("organization_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: membershipRoleEnum("role").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgUserUnique: uniqueIndex("org_membership_org_user_unique").on(
    table.organizationId,
    table.userId,
  ),
  userIdx: index("org_membership_user_idx").on(table.userId),
}));

// ---------------------------------------------------------------------------
// Chart of accounts & ledger
// ---------------------------------------------------------------------------

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  type: accountTypeEnum("type").notNull(),
  subType: text("sub_type"),
  currency: text("currency").notNull(),
  isControlAccount: boolean("is_control_account").notNull().default(false),
  isSystemAccount: boolean("is_system_account").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  description: text("description"),
  parentAccountId: uuid("parent_account_id").references((): AnyPgColumn => accounts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgCodeUnique: uniqueIndex("accounts_org_code_unique").on(table.organizationId, table.code),
  orgTypeIdx: index("accounts_org_type_idx").on(table.organizationId, table.type),
}));

export const fiscalPeriods = pgTable("fiscal_periods", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  startDate: timestamp("start_date", { withTimezone: true, mode: "date" }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true, mode: "date" }).notNull(),
  status: fiscalPeriodStatusEnum("status").notNull().default("OPEN"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedById: uuid("locked_by_id"),
  lockReason: text("lock_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgLabelUnique: uniqueIndex("fiscal_periods_org_label_unique").on(
    table.organizationId,
    table.label,
  ),
  orgDatesIdx: index("fiscal_periods_org_dates_idx").on(
    table.organizationId,
    table.startDate,
    table.endDate,
  ),
}));

/** Reference table, not tenant-scoped. */
export const currencies = pgTable("currencies", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  decimalPlaces: integer("decimal_places").notNull().default(2),
});

export const exchangeRates = pgTable("exchange_rates", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id, {
    onDelete: "cascade",
  }),
  fromCurrency: text("from_currency").notNull(),
  toCurrency: text("to_currency").notNull(),
  rate: numeric("rate", { precision: 18, scale: 8 }).notNull(),
  asOfDate: timestamp("as_of_date", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  lookupIdx: index("exchange_rates_lookup_idx").on(
    table.fromCurrency,
    table.toCurrency,
    table.asOfDate,
  ),
}));

export const taxCodes = pgTable("tax_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  rate: numeric("rate", { precision: 6, scale: 4 }).notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true, mode: "date" }),
  isActive: boolean("is_active").notNull().default(true),
  /**
   * The liability account tax collected under this code is credited to
   * (e.g. "GST Payable") — set once per tax code, per docs/database.md's
   * "explicit, not inferred" convention for every other account reference
   * in this schema. Nullable because Phase 1 seeded tax codes before Phase
   * 3 existed; `InvoiceService` rejects posting an invoice line that uses a
   * tax code with no `payableAccountId` configured.
   */
  payableAccountId: uuid("payable_account_id").references((): AnyPgColumn => accounts.id),
  /**
   * The asset account tax paid under this code is debited to (e.g. "GST
   * Receivable" / input tax credit) — the purchase-side mirror of
   * `payableAccountId`, set once per tax code. Added in Phase 4 Slice 1;
   * nullable for the same reason `payableAccountId` is — `BillService`
   * rejects posting a bill line that uses a tax code with no
   * `receivableAccountId` configured. A tax code can carry both fields at
   * once (the common case for a single GST rate used on both sales and
   * purchases).
   */
  receivableAccountId: uuid("receivable_account_id").references((): AnyPgColumn => accounts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgCodeEffectiveUnique: uniqueIndex("tax_codes_org_code_effective_unique").on(
    table.organizationId,
    table.code,
    table.effectiveFrom,
  ),
}));

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  kind: contactKindEnum("kind").notNull(),
  displayName: text("display_name").notNull(),
  legalName: text("legal_name"),
  email: text("email"),
  phone: text("phone"),
  taxNumber: text("tax_number"),
  billingAddress: jsonb("billing_address"),
  currency: text("currency").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgKindIdx: index("contacts_org_kind_idx").on(table.organizationId, table.kind),
}));

export const dimensions = pgTable("dimensions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgKeyUnique: uniqueIndex("dimensions_org_key_unique").on(table.organizationId, table.key),
}));

export const dimensionValues = pgTable("dimension_values", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  dimensionId: uuid("dimension_id")
    .notNull()
    .references(() => dimensions.id, { onDelete: "cascade" }),
  value: text("value").notNull(),
  label: text("label").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  dimensionValueUnique: uniqueIndex("dimension_values_dimension_value_unique").on(
    table.dimensionId,
    table.value,
  ),
}));

export const journalEntries = pgTable("journal_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  entryNumber: text("entry_number").notNull(),
  postingDate: timestamp("posting_date", { withTimezone: true, mode: "date" }).notNull(),
  memo: text("memo"),
  status: journalEntryStatusEnum("status").notNull().default("DRAFT"),
  sourceType: journalEntrySourceTypeEnum("source_type").notNull().default("MANUAL"),
  fiscalPeriodId: uuid("fiscal_period_id").references(() => fiscalPeriods.id),
  reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => journalEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  postedById: uuid("posted_by_id"),
}, (table) => ({
  orgEntryNumberUnique: uniqueIndex("journal_entries_org_entry_number_unique").on(
    table.organizationId,
    table.entryNumber,
  ),
  reversalOfUnique: uniqueIndex("journal_entries_reversal_of_unique").on(table.reversalOfId),
  orgPostingDateIdx: index("journal_entries_org_posting_date_idx").on(
    table.organizationId,
    table.postingDate,
  ),
  orgStatusIdx: index("journal_entries_org_status_idx").on(table.organizationId, table.status),
}));

export const journalLines = pgTable("journal_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  journalEntryId: uuid("journal_entry_id")
    .notNull()
    .references(() => journalEntries.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  taxCodeId: uuid("tax_code_id").references(() => taxCodes.id),
  memo: text("memo"),
  currency: text("currency").notNull(),
  exchangeRate: numeric("exchange_rate", { precision: 18, scale: 8 }).notNull().default("1"),
  debit: numeric("debit", { precision: 19, scale: 4 }).notNull().default("0"),
  credit: numeric("credit", { precision: 19, scale: 4 }).notNull().default("0"),
  baseDebit: numeric("base_debit", { precision: 19, scale: 4 }).notNull().default("0"),
  baseCredit: numeric("base_credit", { precision: 19, scale: 4 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  entryLineUnique: uniqueIndex("journal_lines_entry_line_unique").on(
    table.journalEntryId,
    table.lineNumber,
  ),
  orgAccountIdx: index("journal_lines_org_account_idx").on(table.organizationId, table.accountId),
}));

export const journalLineDimensions = pgTable("journal_line_dimensions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  journalLineId: uuid("journal_line_id")
    .notNull()
    .references(() => journalLines.id, { onDelete: "cascade" }),
  dimensionId: uuid("dimension_id")
    .notNull()
    .references(() => dimensions.id),
  dimensionValueId: uuid("dimension_value_id")
    .notNull()
    .references(() => dimensionValues.id),
}, (table) => ({
  lineDimensionUnique: uniqueIndex("journal_line_dimensions_line_dimension_unique").on(
    table.journalLineId,
    table.dimensionId,
  ),
}));

// ---------------------------------------------------------------------------
// Banking (Phase 2) — see docs/decisions/0006-bank-feed-abstraction.md
// ---------------------------------------------------------------------------

/**
 * A bank account as the organization sees it, always paired 1:1 with the
 * ASSET ledger account it represents (`glAccountId`) — importing or
 * reconciling a transaction is meaningless without knowing which GL account
 * to post to. `provider`/`externalAccountId` are populated once a live feed
 * is connected; both are null for a manually-imported account.
 */
export const bankAccounts = pgTable("bank_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  glAccountId: uuid("gl_account_id")
    .notNull()
    .references(() => accounts.id),
  name: text("name").notNull(),
  institutionName: text("institution_name"),
  /** Last 4 digits only — the full account number is never stored. */
  accountNumberLast4: text("account_number_last4"),
  currency: text("currency").notNull(),
  provider: bankFeedProviderEnum("provider").notNull().default("MANUAL"),
  externalAccountId: text("external_account_id"),
  currentBalance: numeric("current_balance", { precision: 19, scale: 4 }),
  currentBalanceAsOf: timestamp("current_balance_as_of", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgGlAccountUnique: uniqueIndex("bank_accounts_org_gl_account_unique").on(
    table.organizationId,
    table.glAccountId,
  ),
}));

/** One row per statement upload — lets an import be traced, and its transactions found, after the fact. */
export const bankImportBatches = pgTable("bank_import_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  bankAccountId: uuid("bank_account_id")
    .notNull()
    .references(() => bankAccounts.id, { onDelete: "cascade" }),
  format: bankImportFormatEnum("format").notNull(),
  fileName: text("file_name"),
  rowCount: integer("row_count").notNull(),
  importedRowCount: integer("imported_row_count").notNull(),
  duplicateRowCount: integer("duplicate_row_count").notNull().default(0),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  importedById: uuid("imported_by_id").notNull(),
}, (table) => ({
  orgAccountIdx: index("bank_import_batches_org_account_idx").on(
    table.organizationId,
    table.bankAccountId,
  ),
}));

/**
 * A single line from an imported statement (or, later, a live feed sync).
 * Staged data, not yet part of the ledger: it only becomes a journal entry
 * once reconciled (matched to an existing entry, or posted as a new one via
 * `ReconciliationService.createJournalFromTransaction`).
 *
 * `amount` follows the bank's own sign convention: positive is money that
 * arrived in the account, negative is money that left it — the same
 * convention OFX (`TRNAMT`) and QIF use natively, and that Money Matters'
 * CSV importer normalizes any signed-amount or separate-debit/credit column
 * layout into.
 *
 * `externalId` is always populated — the provider's own transaction id when
 * one exists (OFX `FITID`, a live feed's id), otherwise a content hash of
 * the row (`external-id.ts`) for formats with no stable id (CSV, QIF). This
 * is what makes re-importing the same statement, or an overlapping date
 * range from a live feed, a no-op instead of a duplicate.
 */
export const bankTransactions = pgTable("bank_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  bankAccountId: uuid("bank_account_id")
    .notNull()
    .references(() => bankAccounts.id, { onDelete: "cascade" }),
  importBatchId: uuid("import_batch_id").references(() => bankImportBatches.id),
  externalId: text("external_id").notNull(),
  postedDate: timestamp("posted_date", { withTimezone: true, mode: "date" }).notNull(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  currency: text("currency").notNull(),
  balanceAfter: numeric("balance_after", { precision: 19, scale: 4 }),
  rawPayload: jsonb("raw_payload"),
  status: bankTransactionStatusEnum("status").notNull().default("UNMATCHED"),
  categorizedAccountId: uuid("categorized_account_id").references(() => accounts.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  appliedRuleId: uuid("applied_rule_id").references((): AnyPgColumn => bankRules.id),
  matchedJournalLineId: uuid("matched_journal_line_id").references(
    (): AnyPgColumn => journalLines.id,
  ),
  matchedById: uuid("matched_by_id"),
  matchedAt: timestamp("matched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  accountExternalIdUnique: uniqueIndex("bank_transactions_account_external_id_unique").on(
    table.bankAccountId,
    table.externalId,
  ),
  orgAccountStatusIdx: index("bank_transactions_org_account_status_idx").on(
    table.organizationId,
    table.bankAccountId,
    table.status,
  ),
  orgPostedDateIdx: index("bank_transactions_org_posted_date_idx").on(
    table.organizationId,
    table.postedDate,
  ),
  matchedJournalLineIdx: index("bank_transactions_matched_journal_line_idx").on(
    table.matchedJournalLineId,
  ),
}));

/**
 * Organization-defined auto-categorization, evaluated in `priority` order
 * (lowest first) against each newly-imported transaction — see
 * `src/domain/banking/bank-rule-matching.ts`. `bankAccountId` null means the
 * rule applies to every bank account in the organization.
 */
export const bankRules = pgTable("bank_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  bankAccountId: uuid("bank_account_id").references(() => bankAccounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  priority: integer("priority").notNull().default(100),
  isActive: boolean("is_active").notNull().default(true),
  /** `BankRuleCondition[]` (all must match) — see src/domain/banking/types.ts. */
  conditions: jsonb("conditions").notNull(),
  /** `BankRuleAction` — see src/domain/banking/types.ts. */
  actions: jsonb("actions").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  orgAccountPriorityIdx: index("bank_rules_org_account_priority_idx").on(
    table.organizationId,
    table.bankAccountId,
    table.priority,
  ),
}));

// ---------------------------------------------------------------------------
// Sales (Phase 3 Slice 1) — customer invoicing & AR core.
// See docs/accounting-engine.md and src/domain/sales/*.
// ---------------------------------------------------------------------------

/**
 * A customer invoice. `arAccountId` names the specific Accounts Receivable
 * control account this invoice posts to (chosen explicitly, the same way a
 * bank account names its own `glAccountId` — no per-organization "default
 * account" magic anywhere else in this schema, so invoicing doesn't
 * introduce one either). `subtotal`/`taxTotal`/`total` are denormalized from
 * `invoice_lines` for cheap list/aging queries, but are only ever written by
 * `InvoiceService` in the same transaction as the lines that justify them —
 * never edited independently.
 */
export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  customerContactId: uuid("customer_contact_id")
    .notNull()
    .references(() => contacts.id),
  invoiceNumber: text("invoice_number").notNull(),
  issueDate: timestamp("issue_date", { withTimezone: true, mode: "date" }).notNull(),
  dueDate: timestamp("due_date", { withTimezone: true, mode: "date" }).notNull(),
  currency: text("currency").notNull(),
  memo: text("memo"),
  arAccountId: uuid("ar_account_id")
    .notNull()
    .references(() => accounts.id),
  status: invoiceStatusEnum("status").notNull().default("DRAFT"),
  subtotal: numeric("subtotal", { precision: 19, scale: 4 }).notNull().default("0"),
  taxTotal: numeric("tax_total", { precision: 19, scale: 4 }).notNull().default("0"),
  total: numeric("total", { precision: 19, scale: 4 }).notNull().default("0"),
  /** Set once, when `InvoiceService.approveAndPost` posts the balanced journal. Never re-pointed. */
  journalEntryId: uuid("journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  /** Set once, when `InvoiceService.voidInvoice` reverses that journal — the original is never edited. */
  voidJournalEntryId: uuid("void_journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  postedById: uuid("posted_by_id"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedById: uuid("voided_by_id"),
  voidReason: text("void_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgInvoiceNumberUnique: uniqueIndex("invoices_org_invoice_number_unique").on(
    table.organizationId,
    table.invoiceNumber,
  ),
  orgStatusIdx: index("invoices_org_status_idx").on(table.organizationId, table.status),
  orgCustomerIdx: index("invoices_org_customer_idx").on(table.organizationId, table.customerContactId),
  orgDueDateIdx: index("invoices_org_due_date_idx").on(table.organizationId, table.dueDate),
}));

/**
 * One line of an invoice. `accountId` is the revenue account this line's
 * `lineAmount` (quantity × unit price) is credited to on posting;
 * `taxCodeId` is optional (a zero-rated/out-of-scope line has none).
 * `lineAmount`/`taxAmount` are computed and stored by `InvoiceService` using
 * `Money`/`decimal.js` — never floating point, per docs/accounting-engine.md §4.
 */
export const invoiceLines = pgTable("invoice_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 19, scale: 4 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 19, scale: 4 }).notNull(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  taxCodeId: uuid("tax_code_id").references(() => taxCodes.id),
  lineAmount: numeric("line_amount", { precision: 19, scale: 4 }).notNull(),
  taxAmount: numeric("tax_amount", { precision: 19, scale: 4 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  invoiceLineUnique: uniqueIndex("invoice_lines_invoice_line_unique").on(
    table.invoiceId,
    table.lineNumber,
  ),
  orgInvoiceIdx: index("invoice_lines_org_invoice_idx").on(table.organizationId, table.invoiceId),
}));

/**
 * A receipt from a customer, which may fund one or more invoices'
 * `payment_allocations`. `depositAccountId` is the ASSET account debited on
 * posting — a bank's own `glAccountId` for a direct bank receipt, or an
 * "Undeposited Funds" clearing account when the deposit hasn't hit the bank
 * feed yet; `bankAccountId` is an optional informational link to Phase 2's
 * `bank_accounts` for a receipt that will later reconcile against an
 * imported bank transaction.
 */
export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  customerContactId: uuid("customer_contact_id")
    .notNull()
    .references(() => contacts.id),
  paymentDate: timestamp("payment_date", { withTimezone: true, mode: "date" }).notNull(),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  currency: text("currency").notNull(),
  method: paymentMethodEnum("method").notNull().default("BANK_TRANSFER"),
  depositAccountId: uuid("deposit_account_id")
    .notNull()
    .references(() => accounts.id),
  bankAccountId: uuid("bank_account_id").references(() => bankAccounts.id),
  reference: text("reference"),
  /** Set once, when `PaymentAllocationService.recordPayment` posts the balanced journal. */
  journalEntryId: uuid("journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  orgCustomerIdx: index("payments_org_customer_idx").on(table.organizationId, table.customerContactId),
  orgDateIdx: index("payments_org_date_idx").on(table.organizationId, table.paymentDate),
}));

/**
 * How much of a `payment` was applied to a given `invoice` — the join that
 * makes partial payments and one-payment-to-many-invoices both work.
 * `PaymentAllocationService` is the only writer, and it enforces the
 * invariant that the sum of a payment's allocations never exceeds the
 * payment's own amount, and that a single allocation never exceeds the
 * invoice's outstanding balance at the moment it's recorded — see
 * docs/accounting-engine.md and the master spec's AR invariants.
 */
export const paymentAllocations = pgTable("payment_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => payments.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  paymentInvoiceUnique: uniqueIndex("payment_allocations_payment_invoice_unique").on(
    table.paymentId,
    table.invoiceId,
  ),
  orgInvoiceIdx: index("payment_allocations_org_invoice_idx").on(table.organizationId, table.invoiceId),
  orgPaymentIdx: index("payment_allocations_org_payment_idx").on(table.organizationId, table.paymentId),
}));

// ---------------------------------------------------------------------------
// Sales (Phase 3 Slice 2) — quotes and recurring invoicing. Both extend the
// Phase 3 Slice 1 invoicing domain directly rather than duplicating it: a
// quote converts straight into a draft `invoices` row (never posts on its
// own), and a recurring template generates a draft `invoices` row too — see
// src/domain/sales/quote-service.ts and recurring-invoice-service.ts.
// ---------------------------------------------------------------------------

/**
 * A customer quote. Deliberately shaped like `invoices` (same line/tax/total
 * approach, reusing `calculateInvoiceTotals`) so `QuoteService.convertToInvoice`
 * can copy a quote's header and lines into a new draft invoice without
 * retyping anything — but a quote is pre-sale, not a financial transaction,
 * so unlike `invoices` there is no `journalEntryId`/`postedAt` here at all.
 */
export const quotes = pgTable("quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  customerContactId: uuid("customer_contact_id")
    .notNull()
    .references(() => contacts.id),
  quoteNumber: text("quote_number").notNull(),
  issueDate: timestamp("issue_date", { withTimezone: true, mode: "date" }).notNull(),
  expiryDate: timestamp("expiry_date", { withTimezone: true, mode: "date" }).notNull(),
  currency: text("currency").notNull(),
  memo: text("memo"),
  status: quoteStatusEnum("status").notNull().default("DRAFT"),
  subtotal: numeric("subtotal", { precision: 19, scale: 4 }).notNull().default("0"),
  taxTotal: numeric("tax_total", { precision: 19, scale: 4 }).notNull().default("0"),
  total: numeric("total", { precision: 19, scale: 4 }).notNull().default("0"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedById: uuid("accepted_by_id"),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  declinedById: uuid("declined_by_id"),
  declineReason: text("decline_reason"),
  /** Set once, when `QuoteService.convertToInvoice` creates the draft invoice. Never re-pointed. */
  convertedInvoiceId: uuid("converted_invoice_id").references((): AnyPgColumn => invoices.id),
  convertedAt: timestamp("converted_at", { withTimezone: true }),
  convertedById: uuid("converted_by_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgQuoteNumberUnique: uniqueIndex("quotes_org_quote_number_unique").on(
    table.organizationId,
    table.quoteNumber,
  ),
  orgStatusIdx: index("quotes_org_status_idx").on(table.organizationId, table.status),
  orgCustomerIdx: index("quotes_org_customer_idx").on(table.organizationId, table.customerContactId),
}));

/** One line of a quote — same shape as `invoice_lines`, see `quotes` above. */
export const quoteLines = pgTable("quote_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  quoteId: uuid("quote_id")
    .notNull()
    .references(() => quotes.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 19, scale: 4 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 19, scale: 4 }).notNull(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  taxCodeId: uuid("tax_code_id").references(() => taxCodes.id),
  lineAmount: numeric("line_amount", { precision: 19, scale: 4 }).notNull(),
  taxAmount: numeric("tax_amount", { precision: 19, scale: 4 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  quoteLineUnique: uniqueIndex("quote_lines_quote_line_unique").on(table.quoteId, table.lineNumber),
  orgQuoteIdx: index("quote_lines_org_quote_idx").on(table.organizationId, table.quoteId),
}));

/**
 * A recurring invoice template — customer, line items, and a schedule.
 * `RecurringInvoiceService.generateDue` is an on-demand action (a human
 * clicks "Generate due invoices"), not a background job — Phase 2 Slice 2's
 * job-queue infrastructure that a real schedule would need isn't built yet,
 * see docs/roadmap.md. Every generated invoice is a normal DRAFT `invoices`
 * row created via `InvoiceService.create`, never auto-approved/auto-posted.
 * `nextRunDate` is advanced past "today" immediately after generating that
 * occurrence, in the same transaction, so re-running the action the same
 * day never double-generates.
 */
export const recurringInvoiceTemplates = pgTable("recurring_invoice_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  customerContactId: uuid("customer_contact_id")
    .notNull()
    .references(() => contacts.id),
  name: text("name").notNull(),
  currency: text("currency").notNull(),
  arAccountId: uuid("ar_account_id")
    .notNull()
    .references(() => accounts.id),
  memo: text("memo"),
  frequency: recurringFrequencyEnum("frequency").notNull(),
  startDate: timestamp("start_date", { withTimezone: true, mode: "date" }).notNull(),
  /** Null means "no end date" — runs until `maxOccurrences` (also null-able) or paused. */
  endDate: timestamp("end_date", { withTimezone: true, mode: "date" }),
  maxOccurrences: integer("max_occurrences"),
  occurrencesGenerated: integer("occurrences_generated").notNull().default(0),
  nextRunDate: timestamp("next_run_date", { withTimezone: true, mode: "date" }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgActiveNextRunIdx: index("recurring_invoice_templates_org_active_next_run_idx").on(
    table.organizationId,
    table.isActive,
    table.nextRunDate,
  ),
  orgCustomerIdx: index("recurring_invoice_templates_org_customer_idx").on(
    table.organizationId,
    table.customerContactId,
  ),
}));

/** One line of a recurring invoice template — copied verbatim onto each generated invoice. */
export const recurringInvoiceTemplateLines = pgTable("recurring_invoice_template_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  templateId: uuid("template_id")
    .notNull()
    .references(() => recurringInvoiceTemplates.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 19, scale: 4 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 19, scale: 4 }).notNull(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  taxCodeId: uuid("tax_code_id").references(() => taxCodes.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  templateLineUnique: uniqueIndex("recurring_invoice_template_lines_template_line_unique").on(
    table.templateId,
    table.lineNumber,
  ),
  orgTemplateIdx: index("recurring_invoice_template_lines_org_template_idx").on(
    table.organizationId,
    table.templateId,
  ),
}));

/**
 * Traces a generated invoice back to the recurring template that produced
 * it — purely informational (shown on the invoice and the template), never
 * used to gate anything; the idempotency guarantee lives entirely in
 * `nextRunDate`, not here.
 */
export const invoiceRecurringSource = pgTable("invoice_recurring_source", {
  invoiceId: uuid("invoice_id")
    .primaryKey()
    .references(() => invoices.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  templateId: uuid("template_id")
    .notNull()
    .references(() => recurringInvoiceTemplates.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgTemplateIdx: index("invoice_recurring_source_org_template_idx").on(table.organizationId, table.templateId),
}));

// ---------------------------------------------------------------------------
// Purchases (Phase 4 Slice 1) — supplier bills & AP core, the mirror image
// of Sales above. See docs/accounting-engine.md and src/domain/purchases/*.
// ---------------------------------------------------------------------------

/**
 * A supplier bill. `apAccountId` names the specific Accounts Payable control
 * account this bill posts to, chosen explicitly the same way `invoices.arAccountId`
 * is — no per-organization "default account" magic. `billNumber` is this
 * organization's own sequential reference (e.g. "BILL-000001"); `supplierReference`
 * is the supplier's own invoice number, purely informational and never used
 * for uniqueness or posting. `subtotal`/`taxTotal`/`total` are denormalized
 * from `bill_lines` for cheap list/aging queries, but are only ever written
 * by `BillService` in the same transaction as the lines that justify them.
 */
export const bills = pgTable("bills", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  supplierContactId: uuid("supplier_contact_id")
    .notNull()
    .references(() => contacts.id),
  billNumber: text("bill_number").notNull(),
  supplierReference: text("supplier_reference"),
  issueDate: timestamp("issue_date", { withTimezone: true, mode: "date" }).notNull(),
  dueDate: timestamp("due_date", { withTimezone: true, mode: "date" }).notNull(),
  currency: text("currency").notNull(),
  memo: text("memo"),
  apAccountId: uuid("ap_account_id")
    .notNull()
    .references(() => accounts.id),
  status: billStatusEnum("status").notNull().default("DRAFT"),
  subtotal: numeric("subtotal", { precision: 19, scale: 4 }).notNull().default("0"),
  taxTotal: numeric("tax_total", { precision: 19, scale: 4 }).notNull().default("0"),
  total: numeric("total", { precision: 19, scale: 4 }).notNull().default("0"),
  /** Set once, when `BillService.approveAndPost` posts the balanced journal. Never re-pointed. */
  journalEntryId: uuid("journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  /** Set once, when `BillService.voidBill` reverses that journal — the original is never edited. */
  voidJournalEntryId: uuid("void_journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  postedById: uuid("posted_by_id"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedById: uuid("voided_by_id"),
  voidReason: text("void_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgBillNumberUnique: uniqueIndex("bills_org_bill_number_unique").on(
    table.organizationId,
    table.billNumber,
  ),
  orgStatusIdx: index("bills_org_status_idx").on(table.organizationId, table.status),
  orgSupplierIdx: index("bills_org_supplier_idx").on(table.organizationId, table.supplierContactId),
  orgDueDateIdx: index("bills_org_due_date_idx").on(table.organizationId, table.dueDate),
}));

/**
 * One line of a bill. `accountId` is the expense/asset account this line's
 * `lineAmount` (quantity × unit price) is debited to on posting; `taxCodeId`
 * is optional. `lineAmount`/`taxAmount` are computed and stored by
 * `BillService` using `Money`/`decimal.js` — never floating point.
 */
export const billLines = pgTable("bill_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  billId: uuid("bill_id")
    .notNull()
    .references(() => bills.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 19, scale: 4 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 19, scale: 4 }).notNull(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  taxCodeId: uuid("tax_code_id").references(() => taxCodes.id),
  lineAmount: numeric("line_amount", { precision: 19, scale: 4 }).notNull(),
  taxAmount: numeric("tax_amount", { precision: 19, scale: 4 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  billLineUnique: uniqueIndex("bill_lines_bill_line_unique").on(table.billId, table.lineNumber),
  orgBillIdx: index("bill_lines_org_bill_idx").on(table.organizationId, table.billId),
}));

/**
 * A payment made to a supplier, which may fund one or more bills'
 * `supplier_payment_allocations`. `paymentAccountId` is the ASSET account
 * credited on posting — a bank's own `glAccountId` for a direct bank
 * payment; `bankAccountId` is an optional informational link to Phase 2's
 * `bank_accounts` for a payment that will later reconcile against an
 * imported bank transaction.
 */
export const supplierPayments = pgTable("supplier_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  supplierContactId: uuid("supplier_contact_id")
    .notNull()
    .references(() => contacts.id),
  paymentDate: timestamp("payment_date", { withTimezone: true, mode: "date" }).notNull(),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  currency: text("currency").notNull(),
  method: paymentMethodEnum("method").notNull().default("BANK_TRANSFER"),
  paymentAccountId: uuid("payment_account_id")
    .notNull()
    .references(() => accounts.id),
  bankAccountId: uuid("bank_account_id").references(() => bankAccounts.id),
  reference: text("reference"),
  /** Set once, when `SupplierPaymentAllocationService.recordPayment` posts the balanced journal. */
  journalEntryId: uuid("journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  orgSupplierIdx: index("supplier_payments_org_supplier_idx").on(
    table.organizationId,
    table.supplierContactId,
  ),
  orgDateIdx: index("supplier_payments_org_date_idx").on(table.organizationId, table.paymentDate),
}));

/**
 * How much of a `supplier_payment` was applied to a given `bill` — the join
 * that makes partial payments and one-payment-to-many-bills both work.
 * `SupplierPaymentAllocationService` is the only writer, and it enforces the
 * invariant that the sum of a payment's allocations never exceeds the
 * payment's own amount, and that a single allocation never exceeds the
 * bill's outstanding balance at the moment it's recorded.
 */
export const supplierPaymentAllocations = pgTable("supplier_payment_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => supplierPayments.id, { onDelete: "cascade" }),
  billId: uuid("bill_id")
    .notNull()
    .references(() => bills.id),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  paymentBillUnique: uniqueIndex("supplier_payment_allocations_payment_bill_unique").on(
    table.paymentId,
    table.billId,
  ),
  orgBillIdx: index("supplier_payment_allocations_org_bill_idx").on(table.organizationId, table.billId),
  orgPaymentIdx: index("supplier_payment_allocations_org_payment_idx").on(
    table.organizationId,
    table.paymentId,
  ),
}));

// ---------------------------------------------------------------------------
// Documents (Phase 2 Slice 2 — receipt/invoice capture, master spec §17)
// ---------------------------------------------------------------------------

/**
 * An uploaded receipt/invoice image or PDF, stored as `bytea` directly in
 * Postgres — a deliberate, temporary decision (no object-storage
 * credentials are available in this environment) behind a small storage
 * abstraction so swapping to real object storage later is additive, not a
 * rework. See docs/decisions/0007-document-storage-bytea.md.
 *
 * `extractedData` is Document AI's raw, schema-validated output (see
 * `src/domain/documents/receipt-extraction-service.ts`) — always a
 * *suggestion* a human reviews before it becomes an expense claim line or
 * bill; nothing here is ever posted automatically.
 */
export const uploadedReceipts = pgTable("uploaded_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  uploadedById: uuid("uploaded_by_id").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size").notNull(),
  fileData: bytea("file_data").notNull(),
  extractionStatus: documentExtractionStatusEnum("extraction_status").notNull().default("NOT_ATTEMPTED"),
  extractedData: jsonb("extracted_data"),
  extractionModel: text("extraction_model"),
  extractionConfidence: numeric("extraction_confidence", { precision: 4, scale: 3 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgIdx: index("uploaded_receipts_org_idx").on(table.organizationId),
}));

// ---------------------------------------------------------------------------
// Expenses (Phase 2 Slice 2 — employee expense claims, master spec §19)
// ---------------------------------------------------------------------------

/**
 * An employee's expense claim. `employeeUserId` (like every other
 * actor-derived column in this schema — `createdById`, `postedById`, etc.)
 * is a plain uuid with no FK: the organizational relationship is via
 * `organization_memberships`, and the user row itself is global, not
 * tenant-scoped. `payableAccountId` is the liability control account
 * ("Employee Reimbursements Payable") credited on approval;
 * `reimbursementAccountId` is the bank/asset account credited when the
 * claim is later marked reimbursed — set at that step, not before, mirroring
 * how bills/invoices keep posting and payment separate.
 */
export const expenseClaims = pgTable("expense_claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  employeeUserId: uuid("employee_user_id").notNull(),
  claimNumber: text("claim_number").notNull(),
  claimDate: timestamp("claim_date", { withTimezone: true, mode: "date" }).notNull(),
  description: text("description").notNull(),
  currency: text("currency").notNull(),
  memo: text("memo"),
  status: expenseClaimStatusEnum("status").notNull().default("DRAFT"),
  payableAccountId: uuid("payable_account_id")
    .notNull()
    .references(() => accounts.id),
  subtotal: numeric("subtotal", { precision: 19, scale: 4 }).notNull().default("0"),
  taxTotal: numeric("tax_total", { precision: 19, scale: 4 }).notNull().default("0"),
  total: numeric("total", { precision: 19, scale: 4 }).notNull().default("0"),
  /** Set once, when `ExpenseClaimService.approve` posts the balanced journal. Never re-pointed. */
  journalEntryId: uuid("journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  /** Set once, when `ExpenseClaimService.markReimbursed` posts the payable→bank journal. */
  reimbursementJournalEntryId: uuid("reimbursement_journal_entry_id").references(
    (): AnyPgColumn => journalEntries.id,
  ),
  reimbursementAccountId: uuid("reimbursement_account_id").references((): AnyPgColumn => accounts.id),
  /** Set once, when `ExpenseClaimService.voidClaim` reverses the approval journal — the original is never edited. */
  voidJournalEntryId: uuid("void_journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  submittedById: uuid("submitted_by_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedById: uuid("approved_by_id"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectedById: uuid("rejected_by_id"),
  rejectionReason: text("rejection_reason"),
  reimbursedAt: timestamp("reimbursed_at", { withTimezone: true }),
  reimbursedById: uuid("reimbursed_by_id"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedById: uuid("voided_by_id"),
  voidReason: text("void_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgClaimNumberUnique: uniqueIndex("expense_claims_org_claim_number_unique").on(
    table.organizationId,
    table.claimNumber,
  ),
  orgStatusIdx: index("expense_claims_org_status_idx").on(table.organizationId, table.status),
  orgEmployeeIdx: index("expense_claims_org_employee_idx").on(table.organizationId, table.employeeUserId),
}));

/**
 * One line of an expense claim. `expenseAccountId` is the expense account
 * debited on approval; `taxCodeId` is optional, following the same input
 * tax credit pattern as `bill_lines` (the receivable account is looked up
 * from the tax code, not stored per line). `receiptId` optionally links the
 * uploaded receipt (Document AI) this line's data was captured/prefilled
 * from — informational only, never a source of truth for the amount once a
 * human has confirmed the line.
 */
export const expenseClaimLines = pgTable("expense_claim_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  expenseClaimId: uuid("expense_claim_id")
    .notNull()
    .references(() => expenseClaims.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  expenseAccountId: uuid("expense_account_id")
    .notNull()
    .references(() => accounts.id),
  taxCodeId: uuid("tax_code_id").references(() => taxCodes.id),
  taxAmount: numeric("tax_amount", { precision: 19, scale: 4 }).notNull().default("0"),
  category: text("category"),
  receiptId: uuid("receipt_id").references(() => uploadedReceipts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  expenseClaimLineUnique: uniqueIndex("expense_claim_lines_claim_line_unique").on(
    table.expenseClaimId,
    table.lineNumber,
  ),
  orgClaimIdx: index("expense_claim_lines_org_claim_idx").on(table.organizationId, table.expenseClaimId),
}));

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

/**
 * Schema only in Phase 1 — see docs/roadmap.md. The generic approval engine
 * (master spec §45) is implemented starting Phase 3.
 */
export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  status: approvalStatusEnum("status").notNull().default("PENDING"),
  requestedById: uuid("requested_by_id").notNull(),
  approvedById: uuid("approved_by_id"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgEntityIdx: index("approvals_org_entity_idx").on(
    table.organizationId,
    table.entityType,
    table.entityId,
  ),
}));

/**
 * Append-only. No update/delete is exposed by the application layer, and the
 * runtime DB role is granted no UPDATE/DELETE on this table — see
 * docs/security.md §7.
 */
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id"),
  actorType: auditActorTypeEnum("actor_type").notNull().default("HUMAN"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgEntityIdx: index("audit_logs_org_entity_idx").on(
    table.organizationId,
    table.entityType,
    table.entityId,
  ),
  orgCreatedAtIdx: index("audit_logs_org_created_at_idx").on(
    table.organizationId,
    table.createdAt,
  ),
}));

// ---------------------------------------------------------------------------
// Relations (used by Drizzle's relational query API — db.query.*)
// ---------------------------------------------------------------------------

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(organizationMemberships),
  accounts: many(accounts),
  fiscalPeriods: many(fiscalPeriods),
  taxCodes: many(taxCodes),
  contacts: many(contacts),
  dimensions: many(dimensions),
  journalEntries: many(journalEntries),
  auditLogs: many(auditLogs),
  bankAccounts: many(bankAccounts),
  bankRules: many(bankRules),
  invoices: many(invoices),
  payments: many(payments),
  bills: many(bills),
  supplierPayments: many(supplierPayments),
}));

export const bankAccountsRelations = relations(bankAccounts, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [bankAccounts.organizationId],
    references: [organizations.id],
  }),
  glAccount: one(accounts, {
    fields: [bankAccounts.glAccountId],
    references: [accounts.id],
  }),
  transactions: many(bankTransactions),
  importBatches: many(bankImportBatches),
  rules: many(bankRules),
}));

export const bankImportBatchesRelations = relations(bankImportBatches, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [bankImportBatches.organizationId],
    references: [organizations.id],
  }),
  bankAccount: one(bankAccounts, {
    fields: [bankImportBatches.bankAccountId],
    references: [bankAccounts.id],
  }),
  transactions: many(bankTransactions),
}));

export const bankTransactionsRelations = relations(bankTransactions, ({ one }) => ({
  organization: one(organizations, {
    fields: [bankTransactions.organizationId],
    references: [organizations.id],
  }),
  bankAccount: one(bankAccounts, {
    fields: [bankTransactions.bankAccountId],
    references: [bankAccounts.id],
  }),
  importBatch: one(bankImportBatches, {
    fields: [bankTransactions.importBatchId],
    references: [bankImportBatches.id],
  }),
  categorizedAccount: one(accounts, {
    fields: [bankTransactions.categorizedAccountId],
    references: [accounts.id],
  }),
  contact: one(contacts, {
    fields: [bankTransactions.contactId],
    references: [contacts.id],
  }),
  appliedRule: one(bankRules, {
    fields: [bankTransactions.appliedRuleId],
    references: [bankRules.id],
  }),
  matchedJournalLine: one(journalLines, {
    fields: [bankTransactions.matchedJournalLineId],
    references: [journalLines.id],
  }),
}));

export const bankRulesRelations = relations(bankRules, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [bankRules.organizationId],
    references: [organizations.id],
  }),
  bankAccount: one(bankAccounts, {
    fields: [bankRules.bankAccountId],
    references: [bankAccounts.id],
  }),
  matchedTransactions: many(bankTransactions),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(organizationMemberships),
}));

export const organizationMembershipsRelations = relations(organizationMemberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMemberships.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [organizationMemberships.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [accounts.organizationId],
    references: [organizations.id],
  }),
  parentAccount: one(accounts, {
    fields: [accounts.parentAccountId],
    references: [accounts.id],
    relationName: "account_hierarchy",
  }),
  childAccounts: many(accounts, { relationName: "account_hierarchy" }),
  journalLines: many(journalLines),
}));

export const fiscalPeriodsRelations = relations(fiscalPeriods, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [fiscalPeriods.organizationId],
    references: [organizations.id],
  }),
  journalEntries: many(journalEntries),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [contacts.organizationId],
    references: [organizations.id],
  }),
  journalLines: many(journalLines),
}));

export const taxCodesRelations = relations(taxCodes, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [taxCodes.organizationId],
    references: [organizations.id],
  }),
  payableAccount: one(accounts, {
    fields: [taxCodes.payableAccountId],
    references: [accounts.id],
  }),
  receivableAccount: one(accounts, {
    fields: [taxCodes.receivableAccountId],
    references: [accounts.id],
  }),
  journalLines: many(journalLines),
  invoiceLines: many(invoiceLines),
  billLines: many(billLines),
}));

export const dimensionsRelations = relations(dimensions, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [dimensions.organizationId],
    references: [organizations.id],
  }),
  values: many(dimensionValues),
}));

export const dimensionValuesRelations = relations(dimensionValues, ({ one, many }) => ({
  dimension: one(dimensions, {
    fields: [dimensionValues.dimensionId],
    references: [dimensions.id],
  }),
  journalLineDimensions: many(journalLineDimensions),
}));

export const journalEntriesRelations = relations(journalEntries, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [journalEntries.organizationId],
    references: [organizations.id],
  }),
  fiscalPeriod: one(fiscalPeriods, {
    fields: [journalEntries.fiscalPeriodId],
    references: [fiscalPeriods.id],
  }),
  reversalOf: one(journalEntries, {
    fields: [journalEntries.reversalOfId],
    references: [journalEntries.id],
    relationName: "journal_reversal",
  }),
  // Inverse of reversalOf. At most one row in practice — reversalOfId is
  // unique — but Drizzle's relation API models self-referencing back-refs
  // as `many()`; callers should read reversedBy[0].
  reversedBy: many(journalEntries, { relationName: "journal_reversal" }),
  lines: many(journalLines),
}));

export const journalLinesRelations = relations(journalLines, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [journalLines.organizationId],
    references: [organizations.id],
  }),
  journalEntry: one(journalEntries, {
    fields: [journalLines.journalEntryId],
    references: [journalEntries.id],
  }),
  account: one(accounts, {
    fields: [journalLines.accountId],
    references: [accounts.id],
  }),
  contact: one(contacts, {
    fields: [journalLines.contactId],
    references: [contacts.id],
  }),
  taxCode: one(taxCodes, {
    fields: [journalLines.taxCodeId],
    references: [taxCodes.id],
  }),
  dimensions: many(journalLineDimensions),
}));

export const journalLineDimensionsRelations = relations(journalLineDimensions, ({ one }) => ({
  journalLine: one(journalLines, {
    fields: [journalLineDimensions.journalLineId],
    references: [journalLines.id],
  }),
  dimensionValue: one(dimensionValues, {
    fields: [journalLineDimensions.dimensionValueId],
    references: [dimensionValues.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  organization: one(organizations, {
    fields: [auditLogs.organizationId],
    references: [organizations.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [invoices.organizationId],
    references: [organizations.id],
  }),
  customer: one(contacts, {
    fields: [invoices.customerContactId],
    references: [contacts.id],
  }),
  arAccount: one(accounts, {
    fields: [invoices.arAccountId],
    references: [accounts.id],
  }),
  journalEntry: one(journalEntries, {
    fields: [invoices.journalEntryId],
    references: [journalEntries.id],
    relationName: "invoice_journal",
  }),
  voidJournalEntry: one(journalEntries, {
    fields: [invoices.voidJournalEntryId],
    references: [journalEntries.id],
    relationName: "invoice_void_journal",
  }),
  lines: many(invoiceLines),
  allocations: many(paymentAllocations),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  organization: one(organizations, {
    fields: [invoiceLines.organizationId],
    references: [organizations.id],
  }),
  invoice: one(invoices, {
    fields: [invoiceLines.invoiceId],
    references: [invoices.id],
  }),
  account: one(accounts, {
    fields: [invoiceLines.accountId],
    references: [accounts.id],
  }),
  taxCode: one(taxCodes, {
    fields: [invoiceLines.taxCodeId],
    references: [taxCodes.id],
  }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [payments.organizationId],
    references: [organizations.id],
  }),
  customer: one(contacts, {
    fields: [payments.customerContactId],
    references: [contacts.id],
  }),
  depositAccount: one(accounts, {
    fields: [payments.depositAccountId],
    references: [accounts.id],
  }),
  bankAccount: one(bankAccounts, {
    fields: [payments.bankAccountId],
    references: [bankAccounts.id],
  }),
  allocations: many(paymentAllocations),
}));

export const paymentAllocationsRelations = relations(paymentAllocations, ({ one }) => ({
  organization: one(organizations, {
    fields: [paymentAllocations.organizationId],
    references: [organizations.id],
  }),
  payment: one(payments, {
    fields: [paymentAllocations.paymentId],
    references: [payments.id],
  }),
  invoice: one(invoices, {
    fields: [paymentAllocations.invoiceId],
    references: [invoices.id],
  }),
}));

export const quotesRelations = relations(quotes, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [quotes.organizationId],
    references: [organizations.id],
  }),
  customer: one(contacts, {
    fields: [quotes.customerContactId],
    references: [contacts.id],
  }),
  convertedInvoice: one(invoices, {
    fields: [quotes.convertedInvoiceId],
    references: [invoices.id],
  }),
  lines: many(quoteLines),
}));

export const quoteLinesRelations = relations(quoteLines, ({ one }) => ({
  organization: one(organizations, {
    fields: [quoteLines.organizationId],
    references: [organizations.id],
  }),
  quote: one(quotes, {
    fields: [quoteLines.quoteId],
    references: [quotes.id],
  }),
  account: one(accounts, {
    fields: [quoteLines.accountId],
    references: [accounts.id],
  }),
  taxCode: one(taxCodes, {
    fields: [quoteLines.taxCodeId],
    references: [taxCodes.id],
  }),
}));

export const recurringInvoiceTemplatesRelations = relations(recurringInvoiceTemplates, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [recurringInvoiceTemplates.organizationId],
    references: [organizations.id],
  }),
  customer: one(contacts, {
    fields: [recurringInvoiceTemplates.customerContactId],
    references: [contacts.id],
  }),
  arAccount: one(accounts, {
    fields: [recurringInvoiceTemplates.arAccountId],
    references: [accounts.id],
  }),
  lines: many(recurringInvoiceTemplateLines),
}));

export const recurringInvoiceTemplateLinesRelations = relations(recurringInvoiceTemplateLines, ({ one }) => ({
  organization: one(organizations, {
    fields: [recurringInvoiceTemplateLines.organizationId],
    references: [organizations.id],
  }),
  template: one(recurringInvoiceTemplates, {
    fields: [recurringInvoiceTemplateLines.templateId],
    references: [recurringInvoiceTemplates.id],
  }),
  account: one(accounts, {
    fields: [recurringInvoiceTemplateLines.accountId],
    references: [accounts.id],
  }),
  taxCode: one(taxCodes, {
    fields: [recurringInvoiceTemplateLines.taxCodeId],
    references: [taxCodes.id],
  }),
}));

export const invoiceRecurringSourceRelations = relations(invoiceRecurringSource, ({ one }) => ({
  organization: one(organizations, {
    fields: [invoiceRecurringSource.organizationId],
    references: [organizations.id],
  }),
  invoice: one(invoices, {
    fields: [invoiceRecurringSource.invoiceId],
    references: [invoices.id],
  }),
  template: one(recurringInvoiceTemplates, {
    fields: [invoiceRecurringSource.templateId],
    references: [recurringInvoiceTemplates.id],
  }),
}));

export const billsRelations = relations(bills, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [bills.organizationId],
    references: [organizations.id],
  }),
  supplier: one(contacts, {
    fields: [bills.supplierContactId],
    references: [contacts.id],
  }),
  apAccount: one(accounts, {
    fields: [bills.apAccountId],
    references: [accounts.id],
  }),
  journalEntry: one(journalEntries, {
    fields: [bills.journalEntryId],
    references: [journalEntries.id],
    relationName: "bill_journal",
  }),
  voidJournalEntry: one(journalEntries, {
    fields: [bills.voidJournalEntryId],
    references: [journalEntries.id],
    relationName: "bill_void_journal",
  }),
  lines: many(billLines),
  allocations: many(supplierPaymentAllocations),
}));

export const billLinesRelations = relations(billLines, ({ one }) => ({
  organization: one(organizations, {
    fields: [billLines.organizationId],
    references: [organizations.id],
  }),
  bill: one(bills, {
    fields: [billLines.billId],
    references: [bills.id],
  }),
  account: one(accounts, {
    fields: [billLines.accountId],
    references: [accounts.id],
  }),
  taxCode: one(taxCodes, {
    fields: [billLines.taxCodeId],
    references: [taxCodes.id],
  }),
}));

export const supplierPaymentsRelations = relations(supplierPayments, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [supplierPayments.organizationId],
    references: [organizations.id],
  }),
  supplier: one(contacts, {
    fields: [supplierPayments.supplierContactId],
    references: [contacts.id],
  }),
  paymentAccount: one(accounts, {
    fields: [supplierPayments.paymentAccountId],
    references: [accounts.id],
  }),
  bankAccount: one(bankAccounts, {
    fields: [supplierPayments.bankAccountId],
    references: [bankAccounts.id],
  }),
  allocations: many(supplierPaymentAllocations),
}));

export const supplierPaymentAllocationsRelations = relations(supplierPaymentAllocations, ({ one }) => ({
  organization: one(organizations, {
    fields: [supplierPaymentAllocations.organizationId],
    references: [organizations.id],
  }),
  payment: one(supplierPayments, {
    fields: [supplierPaymentAllocations.paymentId],
    references: [supplierPayments.id],
  }),
  bill: one(bills, {
    fields: [supplierPaymentAllocations.billId],
    references: [bills.id],
  }),
}));

export const uploadedReceiptsRelations = relations(uploadedReceipts, ({ one }) => ({
  organization: one(organizations, {
    fields: [uploadedReceipts.organizationId],
    references: [organizations.id],
  }),
}));

export const expenseClaimsRelations = relations(expenseClaims, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [expenseClaims.organizationId],
    references: [organizations.id],
  }),
  payableAccount: one(accounts, {
    fields: [expenseClaims.payableAccountId],
    references: [accounts.id],
    relationName: "expense_claim_payable_account",
  }),
  reimbursementAccount: one(accounts, {
    fields: [expenseClaims.reimbursementAccountId],
    references: [accounts.id],
    relationName: "expense_claim_reimbursement_account",
  }),
  journalEntry: one(journalEntries, {
    fields: [expenseClaims.journalEntryId],
    references: [journalEntries.id],
    relationName: "expense_claim_journal",
  }),
  reimbursementJournalEntry: one(journalEntries, {
    fields: [expenseClaims.reimbursementJournalEntryId],
    references: [journalEntries.id],
    relationName: "expense_claim_reimbursement_journal",
  }),
  voidJournalEntry: one(journalEntries, {
    fields: [expenseClaims.voidJournalEntryId],
    references: [journalEntries.id],
    relationName: "expense_claim_void_journal",
  }),
  lines: many(expenseClaimLines),
}));

export const expenseClaimLinesRelations = relations(expenseClaimLines, ({ one }) => ({
  organization: one(organizations, {
    fields: [expenseClaimLines.organizationId],
    references: [organizations.id],
  }),
  expenseClaim: one(expenseClaims, {
    fields: [expenseClaimLines.expenseClaimId],
    references: [expenseClaims.id],
  }),
  expenseAccount: one(accounts, {
    fields: [expenseClaimLines.expenseAccountId],
    references: [accounts.id],
  }),
  taxCode: one(taxCodes, {
    fields: [expenseClaimLines.taxCodeId],
    references: [taxCodes.id],
  }),
  receipt: one(uploadedReceipts, {
    fields: [expenseClaimLines.receiptId],
    references: [uploadedReceipts.id],
  }),
}));
