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
  date,
  numeric,
  integer,
  jsonb,
  uniqueIndex,
  index,
  check,
  foreignKey,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

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

/**
 * The period LOCK LEVEL (master spec §41) — the one lock concept; there is
 * deliberately no parallel "closed" flag. Severity order (see
 * `src/domain/ledger/period-lock.ts`, whose `LOCK_RANK` is the only place the
 * order lives — Postgres enum order is creation order, not severity):
 * OPEN < SOFT_LOCKED < ADVISOR_LOCKED < TAX_LOCKED < HARD_LOCKED. The two
 * middle values were added in Phase 9 Slice 3 (appended, since an enum value
 * can't be inserted retroactively without a rewrite).
 */
export const fiscalPeriodStatusEnum = pgEnum("fiscal_period_status", [
  "OPEN",
  "SOFT_LOCKED",
  "HARD_LOCKED",
  "ADVISOR_LOCKED",
  "TAX_LOCKED",
]);

export const periodCloseStatusEnum = pgEnum("period_close_status", ["NOT_STARTED", "IN_PROGRESS", "CLOSED"]);

export const periodLockEventTypeEnum = pgEnum("period_lock_event_type", [
  "LOCKED",
  "LEVEL_LOWERED",
  "REOPENED",
  "POSTING_OVERRIDE",
  "MIGRATED",
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

/**
 * A label only — no billing, pricing or entitlement logic hangs off it yet
 * (docs/roadmap.md "Platform admin & seat limit"). `EXTENDED` is the slot a
 * future paid extra-seats add-on will occupy; `COMPLIMENTARY` marks an
 * account the platform operator has granted extra capacity at no charge.
 */
export const planTierEnum = pgEnum("plan_tier", ["STANDARD", "EXTENDED", "COMPLIMENTARY"]);

/**
 * `API` (Phase 10 Slice 1) marks a write made through the public developer API with an API key. It is a
 * distinct, NON-human actor type on purpose: every human-only check in the codebase asks "is this actor a
 * HUMAN?" and so refuses an API actor structurally (docs/security.md section 15).
 */
export const auditActorTypeEnum = pgEnum("audit_actor_type", ["HUMAN", "AI", "SYSTEM", "API", "AUTOMATION"]);

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
 * Phase 4 Slice 2 (Purchases — purchase orders). A PO never touches the
 * ledger — see `src/domain/purchases/purchase-order-service.ts` — so this is
 * a pure workflow status, the purchase-side mirror of `quote_status`. `DRAFT`
 * is fully editable. `SENT` is informational (sent to the supplier).
 * `PARTIALLY_RECEIVED`/`RECEIVED` are derived from
 * `purchase_order_lines.quantityReceived` vs. `quantity` and kept in sync by
 * `PurchaseOrderReceiptService`, never a stored belief. `CLOSED` is a manual
 * terminal state for a PO that won't receive any more goods (e.g. the
 * supplier under-shipped and the rest was cancelled). `CANCELLED` means the
 * PO was abandoned before any goods arrived.
 */
export const purchaseOrderStatusEnum = pgEnum("purchase_order_status", [
  "DRAFT",
  "SENT",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CLOSED",
  "CANCELLED",
]);

/**
 * Phase 4 Slice 2 (Purchases — supplier credit notes), the mirror image of
 * `bill_status`. A credit note posts the reverse of a bill (credit the
 * expense/asset account, debit Accounts Payable) via `PostingService` on
 * approval, then can be applied against one or more outstanding bills
 * through `SupplierCreditService.applyToBill` — the mirror of
 * `supplier_payment_allocations`, tracked in `supplier_credit_allocations`.
 * PART_APPLIED/APPLIED are derived from those allocations, never a stored
 * counter.
 */
export const supplierCreditStatusEnum = pgEnum("supplier_credit_status", [
  "DRAFT",
  "APPROVED",
  "PART_APPLIED",
  "APPLIED",
  "VOID",
]);

/**
 * Sales documents slice (customer credit notes), the mirror image of `supplier_credit_status`. A customer credit
 * note posts the reverse of an invoice (debit revenue and GST payable, credit Accounts Receivable) on approval; it
 * can then be applied against open invoices through `customer_credit_allocations`. PART_APPLIED/APPLIED are derived
 * from those allocations, never a stored counter.
 */
export const customerCreditStatusEnum = pgEnum("customer_credit_status", [
  "DRAFT",
  "APPROVED",
  "PART_APPLIED",
  "APPLIED",
  "VOID",
]);

/**
 * Phase 4 Slice 2 (Purchases — payment runs). Segregation of duties (master
 * spec §52) is enforced in `PaymentRunService`, not just this status column:
 * DRAFT is the run being assembled by its creator; AWAITING_APPROVAL is
 * submitted and waiting on a *different* user; APPROVED means a different
 * user approved it and `PaymentRunService` has generated the underlying
 * `supplier_payments` via `SupplierPaymentAllocationService`; PAID is
 * reached immediately alongside APPROVED in this slice, since there is no
 * real bank-file/payment-rail integration yet (see docs/roadmap.md) — the
 * "payment" step records the payments in the ledger exactly like a manual
 * supplier payment, just batched and approval-gated.
 */
export const paymentRunStatusEnum = pgEnum("payment_run_status", [
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "PAID",
  "CANCELLED",
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

/**
 * `saved_reports.visibility` — Phase 5 Slice 2's report builder (master spec
 * §33). PERSONAL is visible only to its creator; ORGANIZATION is visible to
 * anyone in the org who holds `financial_report:read`. There is no
 * `DASHBOARD_WIDGET`/`SCHEDULED` value yet — master spec §33 also describes
 * saving a report as a dashboard widget or a scheduled pack, but no
 * dashboard-widget surface or job-queue infrastructure exists in this
 * codebase yet (see docs/roadmap.md's Phase 5 Slice 2 notes and Phase 2
 * Slice 2's job-queue deferral) to attach either to, so only the two
 * visibilities that are actually usable today are modeled.
 */
export const reportVisibilityEnum = pgEnum("report_visibility", ["PERSONAL", "ORGANIZATION"]);

// ---------------------------------------------------------------------------
// Identity & tenancy
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  /**
   * Set by a platform admin to suspend the account: the user cannot sign in
   * and `getCurrentUser()` (src/lib/session.ts) stops resolving any
   * already-issued JWT session on the very next request. NULL = active.
   */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  /** Time of the last successful sign-in (login security, docs/security.md section 22). */
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  emailUnique: uniqueIndex("users_email_unique").on(table.email),
  // There is no email-verification step, so a case-variant look-alike of a
  // privileged address (the platform admin's) must be impossible at the
  // database level, not merely discouraged in application code: emails are
  // stored normalised (CHECK) and unique case-insensitively (index).
  emailLowerUnique: uniqueIndex("users_email_lower_unique").on(sql`lower(${table.email})`),
  emailNormalised: check("users_email_normalised", sql`${table.email} = lower(btrim(${table.email}))`),
}));

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  baseCurrency: text("base_currency").notNull().default("AUD"),
  country: text("country").notNull().default("AU"),
  industry: text("industry"),
  /**
   * Master spec §8's autonomy level, Phase 6 Slice 2. Only 0, 1 and 2 are
   * meaningful today (see `src/domain/ai-controller/autonomy.ts`): 0/1 is
   * "the AI may only inform/suggest" (the default, and Slice 1's only
   * behavior), 2 is "the AI may additionally prepare a DRAFT a human must
   * separately review and confirm." Levels 3/4 (auto-execution) are
   * deliberately not implemented — see docs/ai-agents.md §3 — and are
   * rejected by `AutonomySettingsService.setLevel` rather than silently
   * accepted and ignored.
   */
  aiAutonomyLevel: integer("ai_autonomy_level").notNull().default(0),
  /**
   * Maximum number of ACTIVE memberships (a "seat" = one active
   * organization_memberships row). Default 2: an account can be shared by two
   * people; more is a future paid add-on. Enforced in the service layer under
   * a row lock on this row — see src/domain/organizations/membership-rules.ts.
   */
  seatLimit: integer("seat_limit").notNull().default(2),
  planTier: planTierEnum("plan_tier").notNull().default("STANDARD"),
  /**
   * Archive (reversible, NOT deletion): while set, nobody can read or write this organization's data through ANY
   * path (session choke point, server actions, public API keys, webhook dispatch, AI auto-execution, practice
   * and consolidation). Nothing is removed - restoring clears these three columns and everything is exactly as it
   * was. The slug stays reserved. See docs/security.md section 17 and src/domain/organizations/archive-rules.ts.
   */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedByUserId: uuid("archived_by_user_id").references(() => users.id),
  archiveReason: text("archive_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  slugUnique: uniqueIndex("organizations_slug_unique").on(table.slug),
  seatLimitPositive: check("organizations_seat_limit_positive", sql`${table.seatLimit} >= 1`),
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

/**
 * Platform-level (NOT tenant-scoped) append-only audit trail of everything a
 * platform admin does. Deliberately has no `organization_id` column: it is not
 * a tenant table and must not be mistaken for one by the tenant-isolation
 * audit in src/db/migrate.ts. `target_organization` is a plain reference (no
 * FK) so the row outlives anything it describes. mm_app is granted
 * SELECT + INSERT only (drizzle/0035_*.sql).
 */
export const platformAdminAuditLogs = pgTable("platform_admin_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  adminUserId: uuid("admin_user_id").notNull(),
  adminEmail: text("admin_email").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  targetOrganization: uuid("target_organization"),
  before: jsonb("before"),
  after: jsonb("after"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  createdAtIdx: index("platform_admin_audit_created_at_idx").on(table.createdAt),
  targetOrgIdx: index("platform_admin_audit_target_org_idx").on(table.targetOrganization, table.createdAt),
  actionIdx: index("platform_admin_audit_action_idx").on(table.action, table.createdAt),
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

/**
 * Phase 8 Slice 2 (BAS / GST preparation). How a tax code's supplies are treated for the Business Activity
 * Statement. NULL on `tax_codes.bas_treatment` means UNCLASSIFIED: the BAS prep service refuses to guess and reports
 * the amounts separately. TAXABLE = GST is charged/claimed at the code's rate; GST_FREE and EXPORT are 0% supplies
 * that still carry input tax credits (reported at G3 and G2 on sales); INPUT_TAXED sales carry no GST and no credits
 * (reported within G1 only); NOT_REPORTED is outside the GST labels entirely. See docs/accounting-engine.md.
 */
export const basGstTreatmentEnum = pgEnum("bas_gst_treatment", [
  "TAXABLE",
  "GST_FREE",
  "EXPORT",
  "INPUT_TAXED",
  "NOT_REPORTED",
]);

export const basStatusEnum = pgEnum("bas_status", ["DRAFT", "FINALISED"]);
export const basFrequencyEnum = pgEnum("bas_frequency", ["MONTHLY", "QUARTERLY"]);

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
  /** Phase 8 Slice 2: BAS treatment. NULL = unclassified (never guessed). See `basGstTreatmentEnum`. */
  basTreatment: basGstTreatmentEnum("bas_treatment"),
  /** Phase 8 Slice 2: purchases under this code are capital purchases (BAS label G10) rather than non-capital (G11). */
  basCapital: boolean("bas_capital").notNull().default(false),
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
  /**
   * Set only when this entry was posted into a locked period under an
   * authorised, audited override (Phase 9 Slice 3, master spec §41/§77): the
   * lock level that was overridden and the free-text reason. SOFT_LOCKED
   * overrides always carry a reason; an ADVISOR_LOCKED posting by an
   * accountant-level role records the level with no reason. Null for every
   * ordinary posting.
   */
  lockOverrideLevel: fiscalPeriodStatusEnum("lock_override_level"),
  lockOverrideReason: text("lock_override_reason"),
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
  /**
   * Phase 7 Slice 1 (Projects & Time Tracking). Which project/job this
   * revenue line should be attributed to for project profitability — see
   * `src/domain/projects/profitability-service.ts` and docs/database.md's
   * note on why this is a dedicated FK rather than the generic dimension
   * system. Null for an invoice line with no project (the common case
   * outside Operations). Never set directly by a human on an ad hoc line
   * that also came from billed time — `ProjectTimeBillingService` sets both
   * this and `taskId` when it builds the line from unbilled timesheet
   * entries.
   */
  projectId: uuid("project_id").references((): AnyPgColumn => projects.id),
  taskId: uuid("task_id").references((): AnyPgColumn => projectTasks.id),
  /**
   * Phase 7 Slice 2 (Inventory). Which catalog product this line sells —
   * a dedicated FK, not the generic dimension system, for the same reason
   * `projectId` above is one: see that field's comment and
   * docs/database.md's note on this slice's own instance of the same
   * judgment call. Null for a line with no catalog product (an ad hoc
   * line, same as always). When set and the product is
   * `TRACKED_INVENTORY`, `accountId` above is resolved from
   * `products.revenueAccountId` by `InvoiceService` — never left to
   * whatever account the caller passed — and posting the invoice also
   * records a `inventory_movements` SALE row and a same-journal COGS
   * debit/inventory-asset credit; see
   * `src/domain/inventory/inventory-service.ts`.
   */
  productId: uuid("product_id").references((): AnyPgColumn => products.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  invoiceLineUnique: uniqueIndex("invoice_lines_invoice_line_unique").on(
    table.invoiceId,
    table.lineNumber,
  ),
  orgInvoiceIdx: index("invoice_lines_org_invoice_idx").on(table.organizationId, table.invoiceId),
  orgProjectIdx: index("invoice_lines_org_project_idx").on(table.organizationId, table.projectId),
  orgProductIdx: index("invoice_lines_org_product_idx").on(table.organizationId, table.productId),
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
  /**
   * The date this allocation took effect, for historical (as-at) statements and aged balances. Null on an allocation
   * made when the payment was recorded (its effective date is then the payment's own `paymentDate`); set when an
   * unapplied receipt is applied to an invoice later (sales documents slice). Never used for "outstanding" today.
   */
  appliedDate: timestamp("applied_date", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  // Not unique any more (sales documents slice): an unapplied receipt can be applied to the same invoice in more
  // than one step, each step being its own row with its own `appliedDate`.
  paymentInvoiceIdx: index("payment_allocations_payment_invoice_idx").on(
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
  /** Set once, when `PurchaseOrderService.convertToBill` creates this bill from a received PO. Never re-pointed. Null for a bill entered directly, the common case. */
  purchaseOrderId: uuid("purchase_order_id").references((): AnyPgColumn => purchaseOrders.id),
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
  /**
   * Optional link to Phase 2 Slice 2's Document AI capture
   * (`src/domain/documents/receipt-service.ts`), reused as-is for bill
   * capture — the same "upload a photo/PDF, pre-fill an editable draft"
   * flow expense claims already have, informational only, never a source of
   * truth once a human has confirmed the line.
   */
  receiptId: uuid("receipt_id").references((): AnyPgColumn => uploadedReceipts.id),
  /** Phase 7 Slice 1: which project/job this cost line is attributed to — see `invoiceLines.projectId`'s comment for why this is a dedicated FK. */
  projectId: uuid("project_id").references((): AnyPgColumn => projects.id),
  taskId: uuid("task_id").references((): AnyPgColumn => projectTasks.id),
  /**
   * Phase 7 Slice 2 (Inventory). Which catalog product this line buys —
   * see `invoiceLines.productId`'s comment for why this is a dedicated
   * FK. When set and the product is `TRACKED_INVENTORY`, `accountId`
   * above is resolved from `products.inventoryAssetAccountId` by
   * `BillService` (buying stock is an asset increase, not an expense),
   * and posting the bill also records an `inventory_movements` PURCHASE
   * row and recomputes that product's weighted-average cost.
   */
  productId: uuid("product_id").references((): AnyPgColumn => products.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  billLineUnique: uniqueIndex("bill_lines_bill_line_unique").on(table.billId, table.lineNumber),
  orgBillIdx: index("bill_lines_org_bill_idx").on(table.organizationId, table.billId),
  orgProjectIdx: index("bill_lines_org_project_idx").on(table.organizationId, table.projectId),
  orgProductIdx: index("bill_lines_org_product_idx").on(table.organizationId, table.productId),
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
// Purchases (Phase 4 Slice 2) — purchase orders, three-way matching,
// recurring bills, supplier credits, payment runs. See
// src/domain/purchases/* and docs/roadmap.md for scope.
// ---------------------------------------------------------------------------

/**
 * A purchase order — never posts to the ledger (see `purchase_order_status`
 * above and `src/domain/purchases/purchase-order-service.ts`), the mirror of
 * `quotes` on the buy side. `PurchaseOrderReceiptService` records deliveries
 * against `purchase_order_lines.quantityReceived`; once every line is fully
 * received the PO's own `status` advances to RECEIVED.
 * `PurchaseOrderService.convertToBill` turns a received (or
 * partially-received) PO into a normal draft `bills` row via
 * `BillService.create`, comparing ordered/received/billed quantities and
 * prices first (three-way match) and surfacing any mismatch to the human
 * confirming the bill — never silently auto-accepting or auto-rejecting it.
 */
export const purchaseOrders = pgTable("purchase_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  supplierContactId: uuid("supplier_contact_id")
    .notNull()
    .references(() => contacts.id),
  poNumber: text("po_number").notNull(),
  issueDate: timestamp("issue_date", { withTimezone: true, mode: "date" }).notNull(),
  expectedDate: timestamp("expected_date", { withTimezone: true, mode: "date" }),
  currency: text("currency").notNull(),
  memo: text("memo"),
  status: purchaseOrderStatusEnum("status").notNull().default("DRAFT"),
  subtotal: numeric("subtotal", { precision: 19, scale: 4 }).notNull().default("0"),
  taxTotal: numeric("tax_total", { precision: 19, scale: 4 }).notNull().default("0"),
  total: numeric("total", { precision: 19, scale: 4 }).notNull().default("0"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedById: uuid("closed_by_id"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledById: uuid("cancelled_by_id"),
  cancelReason: text("cancel_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
  /** Phase 10 Slice 3: set when an automation rule drafted this PO (it is a normal DRAFT, flagged so a person can review or delete it). */
  automationRuleId: uuid("automation_rule_id").references((): AnyPgColumn => automationRules.id, { onDelete: "set null" }),
}, (table) => ({
  orgPoNumberUnique: uniqueIndex("purchase_orders_org_po_number_unique").on(
    table.organizationId,
    table.poNumber,
  ),
  orgStatusIdx: index("purchase_orders_org_status_idx").on(table.organizationId, table.status),
  orgSupplierIdx: index("purchase_orders_org_supplier_idx").on(table.organizationId, table.supplierContactId),
}));

/**
 * One line of a purchase order. `quantityReceived` is maintained only by
 * `PurchaseOrderReceiptService.recordReceipt` (never edited directly) and is
 * the source of truth the PO's own status and the three-way match are
 * derived from — never a value trusted from the caller.
 */
export const purchaseOrderLines = pgTable("purchase_order_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id")
    .notNull()
    .references(() => purchaseOrders.id, { onDelete: "cascade" }),
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
  quantityReceived: numeric("quantity_received", { precision: 19, scale: 4 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  poLineUnique: uniqueIndex("purchase_order_lines_po_line_unique").on(table.purchaseOrderId, table.lineNumber),
  orgPoIdx: index("purchase_order_lines_org_po_idx").on(table.organizationId, table.purchaseOrderId),
}));

/**
 * A goods-received event against a PO — deliberately lightweight (no
 * warehouse/inventory location, no serial/lot tracking; that needs Phase 7's
 * inventory system, see docs/roadmap.md). Recording a receipt only advances
 * `purchase_order_lines.quantityReceived` and the PO's own status; it never
 * posts to the ledger (there is no inventory asset account to debit without
 * a real inventory module — the financial effect happens once, when the
 * resulting bill is approved and posted).
 */
export const purchaseOrderReceipts = pgTable("purchase_order_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id")
    .notNull()
    .references(() => purchaseOrders.id, { onDelete: "cascade" }),
  receivedDate: timestamp("received_date", { withTimezone: true, mode: "date" }).notNull(),
  memo: text("memo"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  orgPoIdx: index("purchase_order_receipts_org_po_idx").on(table.organizationId, table.purchaseOrderId),
}));

/** How much of one PO line a given receipt event covered. */
export const purchaseOrderReceiptLines = pgTable("purchase_order_receipt_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  receiptId: uuid("receipt_id")
    .notNull()
    .references(() => purchaseOrderReceipts.id, { onDelete: "cascade" }),
  purchaseOrderLineId: uuid("purchase_order_line_id")
    .notNull()
    .references(() => purchaseOrderLines.id),
  quantityReceived: numeric("quantity_received", { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgReceiptIdx: index("purchase_order_receipt_lines_org_receipt_idx").on(table.organizationId, table.receiptId),
}));

/**
 * A recurring bill template — the purchase-side mirror of
 * `recurring_invoice_templates`; see
 * `src/domain/purchases/recurring-bill-service.ts`. Reuses
 * `recurring_frequency` and the same `advanceRecurringDate` pure function
 * (`src/domain/sales/recurring-schedule.ts`) since the date-advancement math
 * has nothing sales-specific about it.
 */
export const recurringBillTemplates = pgTable("recurring_bill_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  supplierContactId: uuid("supplier_contact_id")
    .notNull()
    .references(() => contacts.id),
  name: text("name").notNull(),
  currency: text("currency").notNull(),
  apAccountId: uuid("ap_account_id")
    .notNull()
    .references(() => accounts.id),
  memo: text("memo"),
  frequency: recurringFrequencyEnum("frequency").notNull(),
  startDate: timestamp("start_date", { withTimezone: true, mode: "date" }).notNull(),
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
  orgActiveNextRunIdx: index("recurring_bill_templates_org_active_next_run_idx").on(
    table.organizationId,
    table.isActive,
    table.nextRunDate,
  ),
  orgSupplierIdx: index("recurring_bill_templates_org_supplier_idx").on(
    table.organizationId,
    table.supplierContactId,
  ),
}));

/** One line of a recurring bill template — copied verbatim onto each generated bill. */
export const recurringBillTemplateLines = pgTable("recurring_bill_template_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  templateId: uuid("template_id")
    .notNull()
    .references(() => recurringBillTemplates.id, { onDelete: "cascade" }),
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
  templateLineUnique: uniqueIndex("recurring_bill_template_lines_template_line_unique").on(
    table.templateId,
    table.lineNumber,
  ),
  orgTemplateIdx: index("recurring_bill_template_lines_org_template_idx").on(
    table.organizationId,
    table.templateId,
  ),
}));

/** Traces a generated bill back to the recurring template that produced it — informational only, mirrors `invoice_recurring_source`. */
export const billRecurringSource = pgTable("bill_recurring_source", {
  billId: uuid("bill_id")
    .primaryKey()
    .references(() => bills.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  templateId: uuid("template_id")
    .notNull()
    .references(() => recurringBillTemplates.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgTemplateIdx: index("bill_recurring_source_org_template_idx").on(table.organizationId, table.templateId),
}));

/**
 * A supplier credit note — a reduction in what's owed to a supplier (a
 * return, a pricing correction). Shaped like `bills` so
 * `SupplierCreditService` can reuse `calculateBillTotals` verbatim; on
 * approval it posts the mirror image of a bill (credit the expense/asset
 * account, debit Accounts Payable) via `PostingService`, then can be applied
 * against outstanding bills — recorded in `supplier_credit_allocations`,
 * which reduces those bills' balances exactly like a cash payment would.
 */
export const supplierCreditNotes = pgTable("supplier_credit_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  supplierContactId: uuid("supplier_contact_id")
    .notNull()
    .references(() => contacts.id),
  creditNoteNumber: text("credit_note_number").notNull(),
  issueDate: timestamp("issue_date", { withTimezone: true, mode: "date" }).notNull(),
  currency: text("currency").notNull(),
  memo: text("memo"),
  apAccountId: uuid("ap_account_id")
    .notNull()
    .references(() => accounts.id),
  status: supplierCreditStatusEnum("status").notNull().default("DRAFT"),
  subtotal: numeric("subtotal", { precision: 19, scale: 4 }).notNull().default("0"),
  taxTotal: numeric("tax_total", { precision: 19, scale: 4 }).notNull().default("0"),
  total: numeric("total", { precision: 19, scale: 4 }).notNull().default("0"),
  journalEntryId: uuid("journal_entry_id").references((): AnyPgColumn => journalEntries.id),
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
  orgCreditNumberUnique: uniqueIndex("supplier_credit_notes_org_number_unique").on(
    table.organizationId,
    table.creditNoteNumber,
  ),
  orgStatusIdx: index("supplier_credit_notes_org_status_idx").on(table.organizationId, table.status),
  orgSupplierIdx: index("supplier_credit_notes_org_supplier_idx").on(table.organizationId, table.supplierContactId),
}));

/** One line of a supplier credit note — same shape as `bill_lines`. */
export const supplierCreditNoteLines = pgTable("supplier_credit_note_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  creditNoteId: uuid("credit_note_id")
    .notNull()
    .references(() => supplierCreditNotes.id, { onDelete: "cascade" }),
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
  creditLineUnique: uniqueIndex("supplier_credit_note_lines_credit_line_unique").on(
    table.creditNoteId,
    table.lineNumber,
  ),
  orgCreditIdx: index("supplier_credit_note_lines_org_credit_idx").on(table.organizationId, table.creditNoteId),
}));

/**
 * How much of a `supplier_credit_note` was applied against a given `bill` —
 * the mirror of `supplier_payment_allocations`, but the credit applies
 * directly to a bill rather than through a payment. `SupplierCreditService`
 * is the only writer and enforces the same invariants: an allocation never
 * exceeds the credit note's own remaining balance, nor the bill's
 * outstanding balance.
 */
export const supplierCreditAllocations = pgTable("supplier_credit_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  creditNoteId: uuid("credit_note_id")
    .notNull()
    .references(() => supplierCreditNotes.id, { onDelete: "cascade" }),
  billId: uuid("bill_id")
    .notNull()
    .references(() => bills.id),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  creditBillUnique: uniqueIndex("supplier_credit_allocations_credit_bill_unique").on(
    table.creditNoteId,
    table.billId,
  ),
  orgBillIdx: index("supplier_credit_allocations_org_bill_idx").on(table.organizationId, table.billId),
  orgCreditIdx: index("supplier_credit_allocations_org_credit_idx").on(table.organizationId, table.creditNoteId),
}));

/**
 * A customer credit note (sales documents slice) - a reduction in what a customer owes (a return, a pricing or
 * quantity correction). Shaped like `invoices` so `CustomerCreditService` reuses `calculateInvoiceTotals`; on approval
 * it posts the mirror image of an invoice (debit revenue and GST payable, credit Accounts Receivable) via
 * `PostingService`. `invoiceId` optionally links it to the invoice it corrects. Until applied to an invoice through
 * `customer_credit_allocations` it is an unapplied customer credit (a credit balance inside the AR control account).
 */
export const customerCreditNotes = pgTable("customer_credit_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  customerContactId: uuid("customer_contact_id")
    .notNull()
    .references(() => contacts.id),
  /** The invoice this credit corrects, when there is one. Informational plus a cap (linked credits never exceed the invoice total). */
  invoiceId: uuid("invoice_id").references((): AnyPgColumn => invoices.id),
  creditNoteNumber: text("credit_note_number").notNull(),
  issueDate: timestamp("issue_date", { withTimezone: true, mode: "date" }).notNull(),
  currency: text("currency").notNull(),
  memo: text("memo"),
  arAccountId: uuid("ar_account_id")
    .notNull()
    .references(() => accounts.id),
  status: customerCreditStatusEnum("status").notNull().default("DRAFT"),
  subtotal: numeric("subtotal", { precision: 19, scale: 4 }).notNull().default("0"),
  taxTotal: numeric("tax_total", { precision: 19, scale: 4 }).notNull().default("0"),
  total: numeric("total", { precision: 19, scale: 4 }).notNull().default("0"),
  journalEntryId: uuid("journal_entry_id").references((): AnyPgColumn => journalEntries.id),
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
  orgCreditNumberUnique: uniqueIndex("customer_credit_notes_org_number_unique").on(
    table.organizationId,
    table.creditNoteNumber,
  ),
  orgStatusIdx: index("customer_credit_notes_org_status_idx").on(table.organizationId, table.status),
  orgCustomerIdx: index("customer_credit_notes_org_customer_idx").on(table.organizationId, table.customerContactId),
  orgInvoiceIdx: index("customer_credit_notes_org_invoice_idx").on(table.organizationId, table.invoiceId),
}));

/** One line of a customer credit note - same shape as `invoice_lines` (no project/task; a tracked-stock product is refused). */
export const customerCreditNoteLines = pgTable("customer_credit_note_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  creditNoteId: uuid("credit_note_id")
    .notNull()
    .references(() => customerCreditNotes.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 19, scale: 4 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 19, scale: 4 }).notNull(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  taxCodeId: uuid("tax_code_id").references(() => taxCodes.id),
  /** Optional catalog product (non-stock only; its revenue account is used). TRACKED_INVENTORY products are refused. */
  productId: uuid("product_id").references((): AnyPgColumn => products.id),
  lineAmount: numeric("line_amount", { precision: 19, scale: 4 }).notNull(),
  taxAmount: numeric("tax_amount", { precision: 19, scale: 4 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  creditLineUnique: uniqueIndex("customer_credit_note_lines_credit_line_unique").on(
    table.creditNoteId,
    table.lineNumber,
  ),
  orgCreditIdx: index("customer_credit_note_lines_org_credit_idx").on(table.organizationId, table.creditNoteId),
}));

/**
 * How much of a `customer_credit_note` was applied against an `invoice`. APPEND-ONLY: a mistaken application is
 * undone by inserting a NEGATIVE row that points at the original (`reversesAllocationId`), never by editing or
 * deleting one (the table is granted SELECT + INSERT only). Net applied = the plain sum of `amount`. `appliedDate`
 * is the effective date for historical statements. `CustomerCreditService` is the only writer.
 */
export const customerCreditAllocations = pgTable("customer_credit_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  creditNoteId: uuid("credit_note_id")
    .notNull()
    .references(() => customerCreditNotes.id),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id),
  /** Positive = applied; negative = a reversal of an earlier application. Never zero. */
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  appliedDate: timestamp("applied_date", { withTimezone: true, mode: "date" }).notNull(),
  reversesAllocationId: uuid("reverses_allocation_id").references((): AnyPgColumn => customerCreditAllocations.id),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  orgInvoiceIdx: index("customer_credit_allocations_org_invoice_idx").on(table.organizationId, table.invoiceId),
  orgCreditIdx: index("customer_credit_allocations_org_credit_idx").on(table.organizationId, table.creditNoteId),
  reversesUnique: uniqueIndex("customer_credit_allocations_reverses_unique").on(table.reversesAllocationId),
}));

/**
 * The receipt issued for a recorded customer payment (sales documents slice). IMMUTABLE once issued: SELECT + INSERT
 * only. `snapshot` freezes what the receipt said at issue time (customer, amount, method, reference, allocations to
 * invoices, any credit left unapplied); later applications of the unapplied balance never rewrite it. One per payment.
 */
export const customerPaymentReceipts = pgTable("customer_payment_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => payments.id),
  receiptNumber: text("receipt_number").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  issuedById: uuid("issued_by_id"),
}, (table) => ({
  paymentUnique: uniqueIndex("customer_payment_receipts_payment_unique").on(table.paymentId),
  orgNumberUnique: uniqueIndex("customer_payment_receipts_org_number_unique").on(table.organizationId, table.receiptNumber),
}));

/**
 * A batch of approved bills prepared for payment together. Segregation of
 * duties (master spec §52) is enforced in `PaymentRunService`, not derivable
 * from this row alone: `createdById` prepares the run, and a *different*
 * user must be the one who approves it — `PaymentRunService.approve` rejects
 * an approval attempt where `approvedById === createdById`, unless the
 * organization has only one member holding `payment_run:approve` (documented
 * limitation for a one-person/two-person org, see docs/roadmap.md).
 * Approving generates real `supplier_payments` via
 * `SupplierPaymentAllocationService.recordPayment` (one per distinct
 * supplier in the run) — this slice has no real bank-file/payment-rail
 * integration, so "PAID" here means "posted to the ledger", the same
 * financial effect a manual supplier payment already has today, just
 * batched and approval-gated.
 */
export const paymentRuns = pgTable("payment_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  runNumber: text("run_number").notNull(),
  status: paymentRunStatusEnum("status").notNull().default("DRAFT"),
  paymentDate: timestamp("payment_date", { withTimezone: true, mode: "date" }).notNull(),
  currency: text("currency").notNull(),
  /** The ASSET account credited for every payment this run generates. */
  paymentAccountId: uuid("payment_account_id")
    .notNull()
    .references(() => accounts.id),
  memo: text("memo"),
  totalAmount: numeric("total_amount", { precision: 19, scale: 4 }).notNull().default("0"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  submittedById: uuid("submitted_by_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedById: uuid("approved_by_id"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledById: uuid("cancelled_by_id"),
  cancelReason: text("cancel_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id").notNull(),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgRunNumberUnique: uniqueIndex("payment_runs_org_run_number_unique").on(
    table.organizationId,
    table.runNumber,
  ),
  orgStatusIdx: index("payment_runs_org_status_idx").on(table.organizationId, table.status),
}));

/**
 * One bill included in a payment run, with the amount to pay it (defaults to
 * the bill's full outstanding balance at the moment it's added, but is
 * re-validated against the bill's *current* outstanding balance at
 * approval time — never trusted stale). `supplierPaymentId` is set once
 * `PaymentRunService.approve` generates the underlying `supplier_payments`
 * row for this bill's supplier group.
 */
export const paymentRunItems = pgTable("payment_run_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  paymentRunId: uuid("payment_run_id")
    .notNull()
    .references(() => paymentRuns.id, { onDelete: "cascade" }),
  billId: uuid("bill_id")
    .notNull()
    .references(() => bills.id),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  supplierPaymentId: uuid("supplier_payment_id").references((): AnyPgColumn => supplierPayments.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runBillUnique: uniqueIndex("payment_run_items_run_bill_unique").on(table.paymentRunId, table.billId),
  orgRunIdx: index("payment_run_items_org_run_idx").on(table.organizationId, table.paymentRunId),
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
  /** Phase 7 Slice 1: which project/job this cost line is attributed to — see `invoiceLines.projectId`'s comment for why this is a dedicated FK. */
  projectId: uuid("project_id").references((): AnyPgColumn => projects.id),
  taskId: uuid("task_id").references((): AnyPgColumn => projectTasks.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  expenseClaimLineUnique: uniqueIndex("expense_claim_lines_claim_line_unique").on(
    table.expenseClaimId,
    table.lineNumber,
  ),
  orgClaimIdx: index("expense_claim_lines_org_claim_idx").on(table.organizationId, table.expenseClaimId),
  orgProjectIdx: index("expense_claim_lines_org_project_idx").on(table.organizationId, table.projectId),
}));

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

/**
 * LEGACY, unused: schema-only since Phase 1 and never written by the application. The approval engine (master spec
 * s.45) deliberately did not reuse this single-row shape (multi-step approvals need a request, ordered steps and an
 * append-only decision log): it lives in `approval_policies` / `approval_requests` / `approval_steps` /
 * `approval_decisions` at the end of this file. Kept (empty) so migration history and the isolation tests stay valid.
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
// Multi-entity consolidation (Phase 9 Slice 4, master spec §30)
//
// These tables are USER-scoped, not organization-scoped: a consolidation group
// belongs to the user who built it and spans several organizations, so none of
// them can use the `app.current_org_id` tenant policy — and none of them carries
// an `organization_id` column (the member organization is
// `member_organization_id`), so the tenant-isolation audit in
// src/db/isolation-audit.ts never mistakes them for tenant tables. They are
// protected the same way and with the same strength: FORCEd row-level security
// whose only predicate is `owner_user_id = app.current_user_id`, a session
// variable set per transaction by `withUserScope` (src/db/user-scope.ts). There
// is no multi-org predicate anywhere, and no table here references a tenant
// table's rows (account ids are plain uuids resolved through the entity's own
// tenant transaction at read time). See docs/security.md §12 and
// docs/database.md.
// ---------------------------------------------------------------------------

export const entityGroupRoleEnum = pgEnum("entity_group_role", ["PARENT", "SUBSIDIARY"]);

export const intercompanyKindEnum = pgEnum("intercompany_kind", [
  "RECEIVABLE",
  "PAYABLE",
  "LOAN_RECEIVABLE",
  "LOAN_PAYABLE",
  "REVENUE",
  "EXPENSE",
]);

export const consolidationAdjustmentKindEnum = pgEnum("consolidation_adjustment_kind", [
  "ELIMINATION",
  "ADJUSTMENT",
]);

/** A user-owned consolidation group. Never deleted (archived), so its append-only history stays attached. */
export const entityGroups = pgTable("entity_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerNameUnique: uniqueIndex("entity_groups_owner_name_unique").on(table.ownerUserId, table.name),
  idOwnerUnique: uniqueIndex("entity_groups_id_owner_unique").on(table.id, table.ownerUserId),
}));

/**
 * One member organization of a group. Ownership is always 100%: partial
 * ownership needs non-controlling-interest accounting and is deliberately not
 * modelled (docs/accounting-engine.md §9), so there is no ownership column to
 * misuse.
 */
export const entityGroupMembers = pgTable("entity_group_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  memberOrganizationId: uuid("member_organization_id").notNull().references(() => organizations.id),
  role: entityGroupRoleEnum("role").notNull().default("SUBSIDIARY"),
  isIncluded: boolean("is_included").notNull().default(true),
  addedByUserId: uuid("added_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  groupOwnerFk: foreignKey({ columns: [table.groupId, table.ownerUserId], foreignColumns: [entityGroups.id, entityGroups.ownerUserId], name: "entity_group_members_group_owner_fk" }),
  groupOrgUnique: uniqueIndex("entity_group_members_group_org_unique").on(table.groupId, table.memberOrganizationId),
}));

/** The group's own chart of accounts — what consolidated lines are called. Matched by (type, code). */
export const entityGroupAccounts = pgTable("entity_group_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  type: accountTypeEnum("type").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  groupOwnerFk: foreignKey({ columns: [table.groupId, table.ownerUserId], foreignColumns: [entityGroups.id, entityGroups.ownerUserId], name: "entity_group_accounts_group_owner_fk" }),
  groupTypeCodeUnique: uniqueIndex("entity_group_accounts_group_type_code_unique").on(table.groupId, table.type, table.code),
  idGroupUnique: uniqueIndex("entity_group_accounts_id_group_unique").on(table.id, table.groupId),
}));

/**
 * Explicit mapping of one entity account to a group account, overriding the
 * default same-(type, code) rule. `account_id` is a plain uuid with NO foreign
 * key into the tenant `accounts` table (see the section comment); code/name are
 * display snapshots only.
 */
export const entityGroupAccountMappings = pgTable("entity_group_account_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  memberOrganizationId: uuid("member_organization_id").notNull().references(() => organizations.id),
  accountId: uuid("account_id").notNull(),
  accountCode: text("account_code").notNull(),
  accountName: text("account_name").notNull(),
  groupAccountId: uuid("group_account_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  groupOwnerFk: foreignKey({ columns: [table.groupId, table.ownerUserId], foreignColumns: [entityGroups.id, entityGroups.ownerUserId], name: "entity_group_account_mappings_group_owner_fk" }),
  groupAccountFk: foreignKey({ columns: [table.groupAccountId, table.groupId], foreignColumns: [entityGroupAccounts.id, entityGroupAccounts.groupId], name: "entity_group_account_mappings_group_account_fk" }),
  memberFk: foreignKey({ columns: [table.groupId, table.memberOrganizationId], foreignColumns: [entityGroupMembers.groupId, entityGroupMembers.memberOrganizationId], name: "entity_group_account_mappings_member_fk" }).onDelete("cascade"),
  accountUnique: uniqueIndex("entity_group_account_mappings_account_unique").on(table.groupId, table.memberOrganizationId, table.accountId),
}));

/** An entity account designated as intercompany, with the named counterparty entity. */
export const entityGroupIntercompanyAccounts = pgTable("entity_group_intercompany_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  memberOrganizationId: uuid("member_organization_id").notNull().references(() => organizations.id),
  accountId: uuid("account_id").notNull(),
  accountCode: text("account_code").notNull(),
  accountName: text("account_name").notNull(),
  kind: intercompanyKindEnum("kind").notNull(),
  counterpartyOrganizationId: uuid("counterparty_organization_id").notNull().references(() => organizations.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  groupOwnerFk: foreignKey({ columns: [table.groupId, table.ownerUserId], foreignColumns: [entityGroups.id, entityGroups.ownerUserId], name: "entity_group_ic_accounts_group_owner_fk" }),
  memberFk: foreignKey({ columns: [table.groupId, table.memberOrganizationId], foreignColumns: [entityGroupMembers.groupId, entityGroupMembers.memberOrganizationId], name: "entity_group_ic_accounts_member_fk" }).onDelete("cascade"),
  counterpartyFk: foreignKey({ columns: [table.groupId, table.counterpartyOrganizationId], foreignColumns: [entityGroupMembers.groupId, entityGroupMembers.memberOrganizationId], name: "entity_group_ic_accounts_counterparty_fk" }).onDelete("cascade"),
  accountUnique: uniqueIndex("entity_group_ic_accounts_account_unique").on(table.groupId, table.memberOrganizationId, table.accountId),
  notSelf: check("entity_group_ic_accounts_not_self", sql`${table.memberOrganizationId} <> ${table.counterpartyOrganizationId}`),
}));

/**
 * Manual elimination / consolidation adjustment header. APPEND-ONLY (mm_app has
 * SELECT + INSERT only): an adjustment is undone by a new reversing row that
 * points back at it, never edited or deleted. Group-level only — nothing here is
 * ever a `journal_entries` row in any entity's ledger.
 */
export const entityGroupAdjustments = pgTable("entity_group_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  kind: consolidationAdjustmentKindEnum("kind").notNull(),
  effectiveDate: timestamp("effective_date", { withTimezone: true, mode: "date" }).notNull(),
  description: text("description").notNull(),
  reason: text("reason").notNull(),
  reversesAdjustmentId: uuid("reverses_adjustment_id"),
  createdByUserId: uuid("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  groupOwnerFk: foreignKey({ columns: [table.groupId, table.ownerUserId], foreignColumns: [entityGroups.id, entityGroups.ownerUserId], name: "entity_group_adjustments_group_owner_fk" }),
  idGroupUnique: uniqueIndex("entity_group_adjustments_id_group_unique").on(table.id, table.groupId),
  reversesUnique: uniqueIndex("entity_group_adjustments_reverses_unique").on(table.reversesAdjustmentId),
  groupDateIdx: index("entity_group_adjustments_group_date_idx").on(table.groupId, table.effectiveDate),
}));

/** Adjustment lines against GROUP accounts. APPEND-ONLY, like the header. */
export const entityGroupAdjustmentLines = pgTable("entity_group_adjustment_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  adjustmentId: uuid("adjustment_id").notNull(),
  groupId: uuid("group_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  groupAccountId: uuid("group_account_id").notNull(),
  debit: numeric("debit", { precision: 19, scale: 4 }).notNull().default("0"),
  credit: numeric("credit", { precision: 19, scale: 4 }).notNull().default("0"),
  memo: text("memo"),
}, (table) => ({
  groupOwnerFk: foreignKey({ columns: [table.groupId, table.ownerUserId], foreignColumns: [entityGroups.id, entityGroups.ownerUserId], name: "entity_group_adjustment_lines_group_owner_fk" }),
  adjustmentFk: foreignKey({ columns: [table.adjustmentId, table.groupId], foreignColumns: [entityGroupAdjustments.id, entityGroupAdjustments.groupId], name: "entity_group_adjustment_lines_adjustment_fk" }),
  groupAccountFk: foreignKey({ columns: [table.groupAccountId, table.groupId], foreignColumns: [entityGroupAccounts.id, entityGroupAccounts.groupId], name: "entity_group_adjustment_lines_group_account_fk" }),
  oneSided: check("entity_group_adjustment_lines_one_sided", sql`${table.debit} >= 0 AND ${table.credit} >= 0 AND (${table.debit} = 0 OR ${table.credit} = 0)`),
  adjustmentIdx: index("entity_group_adjustment_lines_adjustment_idx").on(table.adjustmentId),
}));

/** Group-level append-only audit trail (mm_app: SELECT + INSERT only). */
export const entityGroupAuditLogs = pgTable("entity_group_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  actorUserId: uuid("actor_user_id").notNull(),
  actorType: auditActorTypeEnum("actor_type").notNull().default("HUMAN"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  groupOwnerFk: foreignKey({ columns: [table.groupId, table.ownerUserId], foreignColumns: [entityGroups.id, entityGroups.ownerUserId], name: "entity_group_audit_logs_group_owner_fk" }),
  groupCreatedIdx: index("entity_group_audit_logs_group_created_idx").on(table.groupId, table.createdAt),
}));

// ---------------------------------------------------------------------------
// Phase 9 Slice 5 — accountant practice management & workpapers
// (master spec §42/§43). See docs/security.md section 13 for the scoping model.
//
// Two kinds of table live here:
//
//  * PRACTICE-scoped (carry `practice_id`, never `organization_id`): the
//    practice's own internal data — staff, client links, tasks, workpapers,
//    review notes. Row-level security keys on the single session variable
//    `app.current_user_id` and an EXISTS over the practice's own membership
//    tables (drizzle/0041_*), so only an ACTIVE staff member of the practice
//    can reach a row. They are reached through `withUserScope`.
//
//  * TENANT-scoped (carry `organization_id`): the consent record and the
//    client-visible requests. They belong to the CLIENT organization, are
//    isolated by `app.current_org_id` like every other tenant table, and are
//    reached through `withTenant`.
// ---------------------------------------------------------------------------

export const practiceRoleEnum = pgEnum("practice_role", ["PARTNER", "MANAGER", "STAFF"]);
export const practiceMemberStatusEnum = pgEnum("practice_member_status", ["ACTIVE", "REMOVED"]);
/** One enum for both sides of the handshake: the tenant-side consent record and the practice-side link mirror. */
export const practiceLinkStatusEnum = pgEnum("practice_link_status", ["PENDING", "ACTIVE", "DECLINED", "REVOKED", "WITHDRAWN"]);
export const practiceTaskStatusEnum = pgEnum("practice_task_status", ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"]);
export const practiceTaskPriorityEnum = pgEnum("practice_task_priority", ["LOW", "NORMAL", "HIGH"]);
export const practiceTaskCategoryEnum = pgEnum("practice_task_category", [
  "BAS",
  "TAX",
  "PAYROLL",
  "YEAR_END",
  "REVIEW",
  "BOOKKEEPING",
  "OTHER",
]);
export const practiceDeadlineFrequencyEnum = pgEnum("practice_deadline_frequency", ["MONTHLY", "QUARTERLY", "ANNUAL"]);
export const workpaperKindEnum = pgEnum("workpaper_kind", ["BALANCE_SHEET_ACCOUNT_RECONCILIATION"]);
export const workpaperStatusEnum = pgEnum("workpaper_status", ["DRAFT", "IN_REVIEW", "SIGNED_OFF"]);
export const workpaperSignoffStepEnum = pgEnum("workpaper_signoff_step", ["PREPARER", "REVIEWER", "REOPEN"]);
export const workpaperScheduleLineKindEnum = pgEnum("workpaper_schedule_line_kind", ["SUPPORTING_BALANCE", "RECONCILING_ITEM"]);
export const workpaperReviewNoteStatusEnum = pgEnum("workpaper_review_note_status", ["OPEN", "RESOLVED"]);
export const workpaperAdjustmentStatusEnum = pgEnum("workpaper_adjustment_status", ["PROPOSED", "DISMISSED", "POSTED"]);
export const clientRequestTypeEnum = pgEnum("client_request_type", ["QUERY", "DOCUMENT_REQUEST"]);
export const clientRequestStatusEnum = pgEnum("client_request_status", ["OPEN", "ANSWERED", "CLOSED"]);
export const clientRequestSideEnum = pgEnum("client_request_side", ["PRACTICE", "CLIENT"]);

/** The practice itself. Visible to its creator and to its ACTIVE staff. */
export const practices = pgTable("practices", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * ANCHOR table: "the practices I am a partner of". Own-row policy only
 * (`user_id = app.current_user_id`) — a trivial predicate with no sub-select,
 * which is what lets `practice_members` let a partner see (and therefore
 * update) the other staff rows without a self-referencing policy (Postgres
 * rejects those as infinite recursion). A row is created for the founder and
 * for a promoted partner, and deleted by the partner themselves when they step
 * down; a partner cannot be removed by someone else (docs/security.md s.13).
 */
export const practicePartners = pgTable("practice_partners", {
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: uniqueIndex("practice_partners_practice_user_unique").on(table.practiceId, table.userId),
}));

/**
 * The GATE: every other practice table's policy asks "is there an ACTIVE row
 * here for me, in this practice?". A staff member sees their own row; a partner
 * (via `practice_partners`) sees every row of their practice.
 */
export const practiceMembers = pgTable("practice_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: practiceRoleEnum("role").notNull().default("STAFF"),
  status: practiceMemberStatusEnum("status").notNull().default("ACTIVE"),
  invitedByUserId: uuid("invited_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  practiceUserUnique: uniqueIndex("practice_members_practice_user_unique").on(table.practiceId, table.userId),
  mirrorUnique: uniqueIndex("practice_members_mirror_unique").on(table.practiceId, table.userId, table.role, table.status),
}));

/**
 * The colleague directory: a read-only MIRROR of `practice_members` that any
 * ACTIVE member may read (so staff can pick an assignee and the sign-off rule
 * can count reviewers). Its role/status are not independent — a composite
 * foreign key with ON UPDATE CASCADE makes the database keep them equal to the
 * authoritative row.
 */
export const practiceRoster = pgTable("practice_roster", {
  practiceId: uuid("practice_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: practiceRoleEnum("role").notNull(),
  status: practiceMemberStatusEnum("status").notNull(),
}, (table) => ({
  pk: uniqueIndex("practice_roster_practice_user_unique").on(table.practiceId, table.userId),
  memberFk: foreignKey({
    columns: [table.practiceId, table.userId, table.role, table.status],
    foreignColumns: [practiceMembers.practiceId, practiceMembers.userId, practiceMembers.role, practiceMembers.status],
    name: "practice_roster_member_fk",
  }).onUpdate("cascade"),
}));

/** Append-only practice-level audit trail (INSERT/SELECT only for mm_app). */
export const practiceAuditLogs = pgTable("practice_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  actorUserId: uuid("actor_user_id").notNull(),
  actorType: auditActorTypeEnum("actor_type").notNull().default("HUMAN"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  practiceCreatedIdx: index("practice_audit_logs_practice_created_idx").on(table.practiceId, table.createdAt),
}));

/**
 * The practice's side of a client link. The AUTHORITATIVE consent record is
 * `practice_client_consents` in the client organization (the client controls
 * it); this row is the practice's own working copy (name, assignee, when its
 * status was last verified against the client's record). The practice never
 * reads a client's data on the strength of this row — every read re-checks the
 * client's own record inside the same transaction.
 */
export const practiceClientLinks = pgTable("practice_client_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  clientOrganizationId: uuid("client_organization_id").notNull().references(() => organizations.id),
  clientName: text("client_name").notNull(),
  clientSlug: text("client_slug").notNull(),
  status: practiceLinkStatusEnum("status").notNull().default("PENDING"),
  proposedByUserId: uuid("proposed_by_user_id").notNull(),
  assignedUserId: uuid("assigned_user_id"),
  statusVerifiedAt: timestamp("status_verified_at", { withTimezone: true }),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  practiceClientUnique: uniqueIndex("practice_client_links_practice_client_unique").on(table.practiceId, table.clientOrganizationId),
  practiceStatusIdx: index("practice_client_links_practice_status_idx").on(table.practiceId, table.status),
  assigneeFk: foreignKey({
    columns: [table.practiceId, table.assignedUserId],
    foreignColumns: [practiceMembers.practiceId, practiceMembers.userId],
    name: "practice_client_links_assignee_fk",
  }),
}));

export const practiceClientGroups = pgTable("practice_client_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  name: text("name").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  nameUnique: uniqueIndex("practice_client_groups_practice_name_unique").on(table.practiceId, table.name),
  idPracticeUnique: uniqueIndex("practice_client_groups_id_practice_unique").on(table.id, table.practiceId),
}));

export const practiceClientGroupMembers = pgTable("practice_client_group_members", {
  groupId: uuid("group_id").notNull(),
  practiceId: uuid("practice_id").notNull(),
  clientOrganizationId: uuid("client_organization_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: uniqueIndex("practice_client_group_members_unique").on(table.groupId, table.clientOrganizationId),
  groupFk: foreignKey({
    columns: [table.groupId, table.practiceId],
    foreignColumns: [practiceClientGroups.id, practiceClientGroups.practiceId],
    name: "practice_client_group_members_group_fk",
  }),
  linkFk: foreignKey({
    columns: [table.practiceId, table.clientOrganizationId],
    foreignColumns: [practiceClientLinks.practiceId, practiceClientLinks.clientOrganizationId],
    name: "practice_client_group_members_link_fk",
  }),
}));

/**
 * The materialised dashboard indicators: ONE row per (practice, client), the
 * latest refresh. A NULL measurement means "not measured" (the refreshing
 * staff member's role in that client lacked the permission) — never zero.
 * Counts only: no amounts and no client names beyond the link row.
 */
export const clientHealthSnapshots = pgTable("client_health_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  practiceId: uuid("practice_id").notNull(),
  clientOrganizationId: uuid("client_organization_id").notNull(),
  /** OK | NO_ACCESS (refresher was not a member) | LINK_INACTIVE | ERROR. */
  state: text("state").notNull(),
  detail: text("detail"),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  computedByUserId: uuid("computed_by_user_id").notNull(),
  computedByRole: text("computed_by_role"),
  periodLabel: text("period_label"),
  lockLevel: text("lock_level"),
  booksPercent: integer("books_percent"),
  blockingCount: integer("blocking_count"),
  attentionCount: integer("attention_count"),
  unreconciledCount: integer("unreconciled_count"),
  uncategorisedCount: integer("uncategorised_count"),
  draftPayRuns: integer("draft_pay_runs"),
  /** The end date (YYYY-MM-DD) of the latest period that is TAX_LOCKED or HARD_LOCKED, or null. */
  taxLockedThrough: text("tax_locked_through"),
}, (table) => ({
  practiceClientUnique: uniqueIndex("client_health_snapshots_practice_client_unique").on(table.practiceId, table.clientOrganizationId),
  linkFk: foreignKey({
    columns: [table.practiceId, table.clientOrganizationId],
    foreignColumns: [practiceClientLinks.practiceId, practiceClientLinks.clientOrganizationId],
    name: "client_health_snapshots_link_fk",
  }),
}));

export const practiceDeadlineTemplates = pgTable("practice_deadline_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  clientOrganizationId: uuid("client_organization_id"),
  name: text("name").notNull(),
  category: practiceTaskCategoryEnum("category").notNull().default("BAS"),
  frequency: practiceDeadlineFrequencyEnum("frequency").notNull(),
  /** The calendar month (1-12) in which a period ends. QUARTERLY periods end every third month from it; MONTHLY ignores it. */
  periodEndMonth: integer("period_end_month").notNull().default(12),
  /** Whole months after the period end in which the deadline falls (0-12). */
  dueMonthsAfter: integer("due_months_after").notNull().default(1),
  /** Day of that month (1-31); clamped to the month's length. */
  dueDay: integer("due_day").notNull().default(28),
  priority: practiceTaskPriorityEnum("priority").notNull().default("NORMAL"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdByUserId: uuid("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idPracticeUnique: uniqueIndex("practice_deadline_templates_id_practice_unique").on(table.id, table.practiceId),
  practiceIdx: index("practice_deadline_templates_practice_idx").on(table.practiceId),
  linkFk: foreignKey({
    columns: [table.practiceId, table.clientOrganizationId],
    foreignColumns: [practiceClientLinks.practiceId, practiceClientLinks.clientOrganizationId],
    name: "practice_deadline_templates_link_fk",
  }),
  rangesCheck: check("practice_deadline_templates_ranges", sql`${table.periodEndMonth} BETWEEN 1 AND 12 AND ${table.dueMonthsAfter} BETWEEN 0 AND 12 AND ${table.dueDay} BETWEEN 1 AND 31`),
}));

export const practiceTasks = pgTable("practice_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  clientOrganizationId: uuid("client_organization_id"),
  title: text("title").notNull(),
  description: text("description"),
  /** YYYY-MM-DD. */
  dueDate: date("due_date", { mode: "string" }),
  status: practiceTaskStatusEnum("status").notNull().default("OPEN"),
  priority: practiceTaskPriorityEnum("priority").notNull().default("NORMAL"),
  category: practiceTaskCategoryEnum("category").notNull().default("OTHER"),
  assignedUserId: uuid("assigned_user_id"),
  createdByUserId: uuid("created_by_user_id").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByUserId: uuid("completed_by_user_id"),
  /** Set when generated from a deadline template: the period (YYYY-MM-DD end) it covers — unique per template, so generating twice is idempotent. */
  templateId: uuid("template_id"),
  periodEnd: date("period_end", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  practiceDueIdx: index("practice_tasks_practice_due_idx").on(table.practiceId, table.status, table.dueDate),
  clientIdx: index("practice_tasks_client_idx").on(table.practiceId, table.clientOrganizationId),
  templatePeriodUnique: uniqueIndex("practice_tasks_template_period_unique").on(table.templateId, table.periodEnd),
  linkFk: foreignKey({
    columns: [table.practiceId, table.clientOrganizationId],
    foreignColumns: [practiceClientLinks.practiceId, practiceClientLinks.clientOrganizationId],
    name: "practice_tasks_link_fk",
  }),
  assigneeFk: foreignKey({
    columns: [table.practiceId, table.assignedUserId],
    foreignColumns: [practiceMembers.practiceId, practiceMembers.userId],
    name: "practice_tasks_assignee_fk",
  }),
  templateFk: foreignKey({
    columns: [table.templateId, table.practiceId],
    foreignColumns: [practiceDeadlineTemplates.id, practiceDeadlineTemplates.practiceId],
    name: "practice_tasks_template_fk",
  }),
}));

/**
 * A digital working paper (master spec s.43). Practice-owned: it records what
 * the practice saw of a client's ledger at a stated moment, and survives the
 * client revoking access (clearly marked as of that past date).
 */
export const workpapers = pgTable("workpapers", {
  id: uuid("id").primaryKey().defaultRandom(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  clientOrganizationId: uuid("client_organization_id").notNull(),
  kind: workpaperKindEnum("kind").notNull().default("BALANCE_SHEET_ACCOUNT_RECONCILIATION"),
  accountId: uuid("account_id").notNull(),
  accountCode: text("account_code").notNull(),
  accountName: text("account_name").notNull(),
  accountType: text("account_type").notNull(),
  currency: text("currency").notNull(),
  /** The balance is "as at the end of this day". YYYY-MM-DD. */
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  status: workpaperStatusEnum("status").notNull().default("DRAFT"),
  /** Bumped by every reopen of a signed-off paper; sign-offs and notes carry the version they belong to. */
  version: integer("version").notNull().default(1),
  preparedByUserId: uuid("prepared_by_user_id").notNull(),
  /** The ledger balance in the account's normal direction, as pulled at `snapshotTakenAt`. */
  ledgerBalance: numeric("ledger_balance", { precision: 19, scale: 4 }).notNull(),
  snapshotTakenAt: timestamp("snapshot_taken_at", { withTimezone: true }).notNull(),
  snapshotTakenByUserId: uuid("snapshot_taken_by_user_id").notNull(),
  /** Carry-forward comparative: the prior period's ledger balance, copied (never recomputed). */
  priorWorkpaperId: uuid("prior_workpaper_id"),
  priorPeriodEnd: date("prior_period_end", { mode: "string" }),
  priorLedgerBalance: numeric("prior_ledger_balance", { precision: 19, scale: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniquePaper: uniqueIndex("workpapers_account_period_unique").on(table.practiceId, table.clientOrganizationId, table.accountId, table.periodEnd),
  idPracticeUnique: uniqueIndex("workpapers_id_practice_unique").on(table.id, table.practiceId),
  practiceStatusIdx: index("workpapers_practice_status_idx").on(table.practiceId, table.status),
  linkFk: foreignKey({
    columns: [table.practiceId, table.clientOrganizationId],
    foreignColumns: [practiceClientLinks.practiceId, practiceClientLinks.clientOrganizationId],
    name: "workpapers_link_fk",
  }),
}));

/** Append-only history of every pull of the ledger balance for a workpaper. */
export const workpaperSnapshots = pgTable("workpaper_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  workpaperId: uuid("workpaper_id").notNull(),
  practiceId: uuid("practice_id").notNull(),
  version: integer("version").notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  ledgerBalance: numeric("ledger_balance", { precision: 19, scale: 4 }).notNull(),
  takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  takenByUserId: uuid("taken_by_user_id").notNull(),
  takenByRole: text("taken_by_role").notNull(),
}, (table) => ({
  workpaperFk: foreignKey({ columns: [table.workpaperId, table.practiceId], foreignColumns: [workpapers.id, workpapers.practiceId], name: "workpaper_snapshots_workpaper_fk" }),
  workpaperIdx: index("workpaper_snapshots_workpaper_idx").on(table.workpaperId, table.takenAt),
}));

export const workpaperScheduleLines = pgTable("workpaper_schedule_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  workpaperId: uuid("workpaper_id").notNull(),
  practiceId: uuid("practice_id").notNull(),
  lineNumber: integer("line_number").notNull(),
  kind: workpaperScheduleLineKindEnum("kind").notNull(),
  description: text("description").notNull(),
  reference: text("reference"),
  /** Signed: a reconciling item that reduces the supporting balance is negative. */
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  /** Copied forward into the next period's workpaper. */
  isRecurring: boolean("is_recurring").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workpaperFk: foreignKey({ columns: [table.workpaperId, table.practiceId], foreignColumns: [workpapers.id, workpapers.practiceId], name: "workpaper_schedule_lines_workpaper_fk" }),
  lineUnique: uniqueIndex("workpaper_schedule_lines_line_unique").on(table.workpaperId, table.lineNumber),
}));

export const workpaperEvidence = pgTable("workpaper_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  workpaperId: uuid("workpaper_id").notNull(),
  practiceId: uuid("practice_id").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size").notNull(),
  fileData: bytea("file_data").notNull(),
  description: text("description"),
  uploadedByUserId: uuid("uploaded_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workpaperFk: foreignKey({ columns: [table.workpaperId, table.practiceId], foreignColumns: [workpapers.id, workpapers.practiceId], name: "workpaper_evidence_workpaper_fk" }),
  workpaperIdx: index("workpaper_evidence_workpaper_idx").on(table.workpaperId),
}));

/** A proposed correction, recorded as a note. It is NEVER posted to the client's ledger by this system. */
export const workpaperAdjustments = pgTable("workpaper_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  workpaperId: uuid("workpaper_id").notNull(),
  practiceId: uuid("practice_id").notNull(),
  description: text("description").notNull(),
  debitAccount: text("debit_account"),
  creditAccount: text("credit_account"),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  status: workpaperAdjustmentStatusEnum("status").notNull().default("PROPOSED"),
  /** Free text the practice enters when the client posts it ("JE-000123"); not verified against the ledger. */
  postedReference: text("posted_reference"),
  createdByUserId: uuid("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workpaperFk: foreignKey({ columns: [table.workpaperId, table.practiceId], foreignColumns: [workpapers.id, workpapers.practiceId], name: "workpaper_adjustments_workpaper_fk" }),
  workpaperIdx: index("workpaper_adjustments_workpaper_idx").on(table.workpaperId),
}));

export const workpaperReviewNotes = pgTable("workpaper_review_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  workpaperId: uuid("workpaper_id").notNull(),
  practiceId: uuid("practice_id").notNull(),
  version: integer("version").notNull(),
  body: text("body").notNull(),
  status: workpaperReviewNoteStatusEnum("status").notNull().default("OPEN"),
  authorUserId: uuid("author_user_id").notNull(),
  resolvedByUserId: uuid("resolved_by_user_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionComment: text("resolution_comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workpaperFk: foreignKey({ columns: [table.workpaperId, table.practiceId], foreignColumns: [workpapers.id, workpapers.practiceId], name: "workpaper_review_notes_workpaper_fk" }),
  workpaperIdx: index("workpaper_review_notes_workpaper_idx").on(table.workpaperId, table.createdAt),
}));

/** Append-only sign-off / reopen history. */
export const workpaperSignoffs = pgTable("workpaper_signoffs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workpaperId: uuid("workpaper_id").notNull(),
  practiceId: uuid("practice_id").notNull(),
  version: integer("version").notNull(),
  step: workpaperSignoffStepEnum("step").notNull(),
  userId: uuid("user_id").notNull(),
  practiceRole: practiceRoleEnum("practice_role").notNull(),
  /** Mandatory for REOPEN. */
  reason: text("reason"),
  /** True when the preparer also signed as reviewer because the practice had a single active staff member. */
  singleStaffException: boolean("single_staff_exception").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workpaperFk: foreignKey({ columns: [table.workpaperId, table.practiceId], foreignColumns: [workpapers.id, workpapers.practiceId], name: "workpaper_signoffs_workpaper_fk" }),
  workpaperIdx: index("workpaper_signoffs_workpaper_idx").on(table.workpaperId, table.createdAt),
}));

/**
 * TENANT-scoped (client organization). The AUTHORITATIVE consent record of the
 * handshake: a practice proposes (PENDING), the client's OWNER/ADMINISTRATOR
 * accepts (ACTIVE) or declines, and may revoke at any time. Only an ACTIVE row
 * lets the practice read this organization — checked inside the same tenant
 * transaction as every read, so revocation is immediate.
 */
export const practiceClientConsents = pgTable("practice_client_consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  /** What the client sees in its own settings. Set by the proposer, so it is shown with the opaque id. */
  practiceName: text("practice_name").notNull(),
  status: practiceLinkStatusEnum("status").notNull().default("PENDING"),
  proposedByUserId: uuid("proposed_by_user_id").notNull(),
  respondedByUserId: uuid("responded_by_user_id"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgPracticeUnique: uniqueIndex("practice_client_consents_org_practice_unique").on(table.organizationId, table.practiceId),
  orgStatusIdx: index("practice_client_consents_org_status_idx").on(table.organizationId, table.status),
}));

/** TENANT-scoped. A query or document request from the client's accountant, visible to the client. */
export const clientRequests = pgTable("client_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  practiceId: uuid("practice_id").notNull(),
  practiceName: text("practice_name").notNull(),
  type: clientRequestTypeEnum("type").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  status: clientRequestStatusEnum("status").notNull().default("OPEN"),
  requestedByUserId: uuid("requested_by_user_id").notNull(),
  dueDate: date("due_date", { mode: "string" }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedByUserId: uuid("closed_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgStatusIdx: index("client_requests_org_status_idx").on(table.organizationId, table.status, table.createdAt),
  idOrgUnique: uniqueIndex("client_requests_id_org_unique").on(table.id, table.organizationId),
}));

/** TENANT-scoped, append-only: the thread under a request, optionally with an attachment stored via the receipt storage abstraction. */
export const clientRequestMessages = pgTable("client_request_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").notNull(),
  authorUserId: uuid("author_user_id").notNull(),
  authorSide: clientRequestSideEnum("author_side").notNull(),
  body: text("body").notNull(),
  attachmentReceiptId: uuid("attachment_receipt_id").references((): AnyPgColumn => uploadedReceipts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  requestFk: foreignKey({ columns: [table.requestId, table.organizationId], foreignColumns: [clientRequests.id, clientRequests.organizationId], name: "client_request_messages_request_fk" }),
  requestIdx: index("client_request_messages_request_idx").on(table.requestId, table.createdAt),
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
  project: one(projects, {
    fields: [invoiceLines.projectId],
    references: [projects.id],
  }),
  task: one(projectTasks, {
    fields: [invoiceLines.taskId],
    references: [projectTasks.id],
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

// ---------------------------------------------------------------------------
// Reporting (Phase 5 Slice 2) — report builder saved queries
// ---------------------------------------------------------------------------

/**
 * A saved report-builder query (master spec §33) — `config` is a JSON-
 * serialized `ReportBuilderConfig` (see
 * `src/domain/reporting/report-builder-service.ts`), never a cached result.
 * Running a saved report always re-executes `config` against current data —
 * see that module's doc comment for why no result column exists here at all.
 */
export const savedReports = pgTable("saved_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  visibility: reportVisibilityEnum("visibility").notNull().default("PERSONAL"),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id").notNull(),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgIdx: index("saved_reports_org_idx").on(table.organizationId),
}));

export const savedReportsRelations = relations(savedReports, ({ one }) => ({
  organization: one(organizations, {
    fields: [savedReports.organizationId],
    references: [organizations.id],
  }),
}));

// ---------------------------------------------------------------------------
// AI Financial Controller — write-capable tool proposals (Phase 6 Slice 2)
// ---------------------------------------------------------------------------

export const aiDraftProposalTypeEnum = pgEnum("ai_draft_proposal_type", [
  "INVOICE",
  "BILL",
  "JOURNAL_ENTRY",
]);

export const aiDraftProposalStatusEnum = pgEnum("ai_draft_proposal_status", [
  "PENDING",
  "CONFIRMED",
  "DISMISSED",
  "EXPIRED",
]);

/**
 * The real human-in-the-loop checkpoint master spec §80/§87.4 require: a
 * write-capable Controller tool (`prepare_draft_invoice`, `prepare_draft_bill`,
 * `prepare_draft_journal_entry` — see `src/domain/ai-controller/write-tools.ts`)
 * never creates an invoice/bill/journal entry itself. It only ever resolves
 * the model's request into a concrete, fully-validated creation payload
 * (real contact id, real account ids — never an id the model merely claims,
 * see `docs/ai-agents.md`) and stores THAT here, PENDING, for a human to
 * review. `AIDraftProposalService.confirm` is the only path that turns a row
 * here into a real DRAFT invoice/bill/journal entry, via the exact same
 * `InvoiceService.create`/`BillService.create`/`PostingService.createDraft`
 * a human using the UI directly would call — never a second ledger-writing
 * code path. `payload` is the resolved `CreateInvoiceInput`/`CreateBillInput`/
 * `JournalEntryDraft` (dates as ISO strings); `preview` is the smaller,
 * human-readable shape the chat UI renders in its "Create this draft?" card.
 * `createdByUserId` is the user whose conversation produced this proposal;
 * `confirmedByUserId` (set only on confirm) is who actually clicked confirm —
 * both are needed per master spec §44's "for AI actions also store: agent,
 * model, ..., proposed action, approver, outcome," and both are also
 * recorded as audit-log metadata, never only here.
 */
export const aiDraftProposals = pgTable("ai_draft_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  proposalType: aiDraftProposalTypeEnum("proposal_type").notNull(),
  status: aiDraftProposalStatusEnum("status").notNull().default("PENDING"),
  createdByUserId: uuid("created_by_user_id").notNull(),
  model: text("model").notNull(),
  conversationQuestion: text("conversation_question").notNull(),
  payload: jsonb("payload").notNull(),
  preview: jsonb("preview").notNull(),
  resultEntityId: uuid("result_entity_id"),
  confirmedByUserId: uuid("confirmed_by_user_id"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => ({
  orgIdx: index("ai_draft_proposals_org_idx").on(table.organizationId),
  orgStatusIdx: index("ai_draft_proposals_org_status_idx").on(table.organizationId, table.status),
}));

export const aiDraftProposalsRelations = relations(aiDraftProposals, ({ one }) => ({
  organization: one(organizations, {
    fields: [aiDraftProposals.organizationId],
    references: [organizations.id],
  }),
}));

// ---------------------------------------------------------------------------
// AI Financial Controller — autonomy Levels 3-4 auto-execution (Phase 6 Slice 3)
// ---------------------------------------------------------------------------

/**
 * Master spec §76's "learn organisation-specific patterns only through
 * controlled configuration" — this is the CLOSED, hand-curated set of action
 * types an organization may ever auto-approve at autonomy Level 3/4 (see
 * `src/domain/ai-controller/auto-execution-policy.ts`). Each one is a
 * mechanism that already exists, was already safe when a human triggered it
 * on demand (`RecurringInvoiceService.generateDue`,
 * `RecurringBillService.generateDue`, `ReconciliationService.confirmMatch`
 * on a deterministic, same-day exact-amount candidate), and is trivially
 * reversible (`InvoiceService.deleteDraft`/`BillService.deleteDraft`/a
 * reconciliation unmatch — never a destructive ledger edit). Deliberately
 * excluded, structurally, by never appearing in this enum: anything
 * touching a supplier payment or payment run, a bank account's own details,
 * payroll, tax, an "unusual" freeform journal entry, or a fiscal period
 * close — see docs/ai-agents.md §3b.
 */
export const aiAutoExecutionActionTypeEnum = pgEnum("ai_auto_execution_action_type", [
  "RECURRING_INVOICE_AUTO_GENERATE",
  "RECURRING_BILL_AUTO_GENERATE",
  "BANK_RECONCILIATION_AUTO_MATCH",
]);

/**
 * The per-org, per-action-type opt-in whitelist itself. A row's mere
 * existence means that action type is auto-approved — turning the autonomy
 * dial to Level 3/4 alone inserts no rows here, so it does nothing by
 * itself (see `AutoApprovedActionsService.isApproved`, which requires BOTH
 * level >= 3 AND a row here, read fresh on every check — never cached,
 * which is also what makes the emergency stop take effect immediately).
 */
export const aiAutoApprovedActions = pgTable("ai_auto_approved_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  actionType: aiAutoExecutionActionTypeEnum("action_type").notNull(),
  enabledByUserId: uuid("enabled_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgActionUnique: uniqueIndex("ai_auto_approved_actions_org_action_unique").on(
    table.organizationId,
    table.actionType,
  ),
}));

export const aiAutoApprovedActionsRelations = relations(aiAutoApprovedActions, ({ one }) => ({
  organization: one(organizations, {
    fields: [aiAutoApprovedActions.organizationId],
    references: [organizations.id],
  }),
}));

/**
 * One row per auto-executed action (master spec §44's "for AI actions also
 * store: agent, model, ..., proposed action, approver, outcome," and §77's
 * "clearly flagged ... in the normal UI, not just the audit log"). This is
 * what the invoice/bill lists and the Daily Finance Brief query to render an
 * "AI auto" badge, and what `AutoExecutionService.undo` reads to find the
 * real entity to reverse. `confidence`/`model` are null for the two
 * recurring-generation action types — they trigger existing, deterministic
 * business logic (the same "generate the due occurrence" a human's button
 * click runs), not an LLM inference, so there is no model confidence to
 * record; only `BANK_RECONCILIATION_AUTO_MATCH` ever has a non-null
 * `confidence`, and even then it is the deterministic matcher's own
 * same-day/exact-amount score, never a probabilistic AI suggestion (see
 * docs/ai-agents.md §3b for why `FuzzyReconciliationService`'s AI-scored
 * suggestions are never auto-confirmed at any level).
 */
export const aiAutoExecutions = pgTable("ai_auto_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  actionType: aiAutoExecutionActionTypeEnum("action_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  model: text("model"),
  autonomyLevel: integer("autonomy_level").notNull(),
  triggeredByUserId: uuid("triggered_by_user_id").notNull(),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  reversedByUserId: uuid("reversed_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgEntityIdx: index("ai_auto_executions_org_entity_idx").on(
    table.organizationId,
    table.entityType,
    table.entityId,
  ),
  orgCreatedAtIdx: index("ai_auto_executions_org_created_at_idx").on(
    table.organizationId,
    table.createdAt,
  ),
}));

export const aiAutoExecutionsRelations = relations(aiAutoExecutions, ({ one }) => ({
  organization: one(organizations, {
    fields: [aiAutoExecutions.organizationId],
    references: [organizations.id],
  }),
}));

// ---------------------------------------------------------------------------
// Phase 7 Slice 1 — Projects/Jobs & Time Tracking
// ---------------------------------------------------------------------------

/**
 * A project/job's lifecycle. `ACTIVE` is open for new time/cost. `ON_HOLD`
 * is paused (still visible, new timesheet entries are refused). `COMPLETED`
 * and `CANCELLED` are both terminal — see `ProjectService.close`. There is
 * no "won/lost" pipeline stage here (that belongs to CRM, not yet built);
 * a project exists once work is actually planned/underway.
 */
export const projectStatusEnum = pgEnum("project_status", [
  "ACTIVE",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
]);

/**
 * A timesheet entry's approval/billing lifecycle (master spec §23). `DRAFT`
 * and `REJECTED` are the only editable states — see
 * `src/domain/projects/timesheet-service.ts`'s `EDITABLE_STATUSES`.
 * `SUBMITTED` awaits a manager's single-approver decision (same pattern as
 * `expense_claim_status`): `APPROVED` or back to `REJECTED` (which an
 * employee can edit and resubmit). `INVOICED` is a one-way terminal state
 * set only by `ProjectTimeBillingService.createInvoiceFromUnbilledTime`,
 * never by hand — once set, the entry is immutable in the same spirit as a
 * posted invoice (see that service's doc comment for the correction path).
 * There is no ledger posting of a timesheet entry by itself; its only
 * financial effect is becoming an invoice line (revenue) when billable, and
 * informing the Estimated-vs-Actual labour figure either way.
 */
export const timesheetEntryStatusEnum = pgEnum("timesheet_entry_status", [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "INVOICED",
]);

/**
 * A project/job (master spec §22). `customerContactId` is optional — an
 * internal project (no external billing) is legitimate, but
 * `ProjectTimeBillingService.createInvoiceFromUnbilledTime` requires one.
 * `budgetedRevenue`/`budgetedCost` are the "Estimated" side of the
 * Estimated-vs-Actual comparison; the "Actual" side is never stored here —
 * it is always computed live from posted invoice/bill/expense-claim lines
 * and approved timesheet entries attributed to this project (see
 * `src/domain/projects/profitability-service.ts`), so it can never drift
 * from the ledger. `defaultHourlyRate` is the simple billing-rate mechanism
 * master spec §22/§23 ask for in this slice — a full rate-card system is
 * explicitly deferred (docs/roadmap.md).
 */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  customerContactId: uuid("customer_contact_id").references(() => contacts.id),
  code: text("code").notNull(),
  name: text("name").notNull(),
  status: projectStatusEnum("status").notNull().default("ACTIVE"),
  currency: text("currency").notNull(),
  budgetedRevenue: numeric("budgeted_revenue", { precision: 19, scale: 4 }).notNull().default("0"),
  budgetedCost: numeric("budgeted_cost", { precision: 19, scale: 4 }).notNull().default("0"),
  /** Default hourly rate billed to the customer for time logged against this project, unless a task overrides it. Null means time on this project can't be invoiced until one is set (on the project or every task used). */
  defaultHourlyRate: numeric("default_hourly_rate", { precision: 19, scale: 4 }),
  startDate: timestamp("start_date", { withTimezone: true, mode: "date" }),
  endDate: timestamp("end_date", { withTimezone: true, mode: "date" }),
  memo: text("memo"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedById: uuid("closed_by_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgCodeUnique: uniqueIndex("projects_org_code_unique").on(table.organizationId, table.code),
  orgStatusIdx: index("projects_org_status_idx").on(table.organizationId, table.status),
  orgCustomerIdx: index("projects_org_customer_idx").on(table.organizationId, table.customerContactId),
}));

/**
 * A flat task within a project — deliberately not a full task-management
 * system (no dependencies, no assignees beyond the implicit link from a
 * timesheet entry, no Gantt planning — see docs/roadmap.md). Exists so a
 * timesheet entry can record "which task on which project", and so a task
 * can carry its own `budgetedHours`/`billingRate` override.
 */
export const projectTasks = pgTable("project_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  budgetedHours: numeric("budgeted_hours", { precision: 19, scale: 2 }),
  /** Overrides `projects.defaultHourlyRate` for time logged against this task specifically. */
  billingRate: numeric("billing_rate", { precision: 19, scale: 4 }),
  isDone: boolean("is_done").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgProjectIdx: index("project_tasks_org_project_idx").on(table.organizationId, table.projectId),
}));

/**
 * One row per logged time entry (master spec §23) — the SAME row whether it
 * came from a start/stop timer (`startedAt`/`endedAt` set, `hours` derived
 * from their difference) or manual entry (`hours` typed directly,
 * `startedAt`/`endedAt` null). `employeeUserId` is unvalidated against
 * `users`, same convention as `expense_claims.employeeUserId`. `billable`
 * decides whether the entry is eligible for
 * `ProjectTimeBillingService.createInvoiceFromUnbilledTime` at all; a
 * non-billable entry still counts toward project labour reporting. Once
 * `invoiceId`/`invoiceLineId` are set (status INVOICED), the row is
 * immutable — see `timesheet_entry_status`'s own comment for the correction
 * path.
 */
export const timesheetEntries = pgTable("timesheet_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  employeeUserId: uuid("employee_user_id").notNull(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  taskId: uuid("task_id").references(() => projectTasks.id),
  entryDate: timestamp("entry_date", { withTimezone: true, mode: "date" }).notNull(),
  hours: numeric("hours", { precision: 19, scale: 2 }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  notes: text("notes"),
  billable: boolean("billable").notNull().default(true),
  status: timesheetEntryStatusEnum("status").notNull().default("DRAFT"),
  /** Snapshot of the hourly rate actually billed, captured at invoicing time — never recomputed later even if the project/task rate subsequently changes. Null until invoiced. */
  billedRate: numeric("billed_rate", { precision: 19, scale: 4 }),
  /** Set once, when `ProjectTimeBillingService.createInvoiceFromUnbilledTime` creates the draft invoice this entry's time was billed on. Never re-pointed — a re-run never reselects an entry with this set. */
  invoiceId: uuid("invoice_id").references((): AnyPgColumn => invoices.id),
  invoiceLineId: uuid("invoice_line_id").references((): AnyPgColumn => invoiceLines.id),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  submittedById: uuid("submitted_by_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedById: uuid("approved_by_id"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectedById: uuid("rejected_by_id"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgProjectIdx: index("timesheet_entries_org_project_idx").on(table.organizationId, table.projectId),
  orgEmployeeIdx: index("timesheet_entries_org_employee_idx").on(table.organizationId, table.employeeUserId),
  orgStatusIdx: index("timesheet_entries_org_status_idx").on(table.organizationId, table.status),
  /**
   * The exact predicate `ProjectTimeBillingService.createInvoiceFromUnbilledTime`
   * selects on — approved, billable, not-yet-invoiced, for a given project —
   * so that query is a cheap index scan, not a sequential scan over every
   * timesheet entry the org has ever logged.
   */
  unbilledLookupIdx: index("timesheet_entries_unbilled_idx").on(
    table.organizationId,
    table.projectId,
    table.status,
    table.billable,
  ),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  customer: one(contacts, {
    fields: [projects.customerContactId],
    references: [contacts.id],
  }),
  tasks: many(projectTasks),
  timesheetEntries: many(timesheetEntries),
}));

export const projectTasksRelations = relations(projectTasks, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projectTasks.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [projectTasks.projectId],
    references: [projects.id],
  }),
  timesheetEntries: many(timesheetEntries),
}));

export const timesheetEntriesRelations = relations(timesheetEntries, ({ one }) => ({
  organization: one(organizations, {
    fields: [timesheetEntries.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [timesheetEntries.projectId],
    references: [projects.id],
  }),
  task: one(projectTasks, {
    fields: [timesheetEntries.taskId],
    references: [projectTasks.id],
  }),
  invoice: one(invoices, {
    fields: [timesheetEntries.invoiceId],
    references: [invoices.id],
  }),
  invoiceLine: one(invoiceLines, {
    fields: [timesheetEntries.invoiceLineId],
    references: [invoiceLines.id],
  }),
}));

// ---------------------------------------------------------------------------
// Phase 7 Slice 2 — Inventory
// ---------------------------------------------------------------------------

/**
 * What a catalog item is, for whether inventory-tracking logic applies to
 * it at all (master spec §20). `TRACKED_INVENTORY` is quantity-tracked with
 * perpetual weighted-average costing (`inventory_movements`,
 * `quantityOnHand`/`averageUnitCost` below). `NON_INVENTORY` and `SERVICE`
 * are both sold/bought through the exact same invoice/bill line UI and the
 * same `productId` FK, but never touch a movement row, a quantity, or a
 * COGS posting — they're here so a service or a non-stock good can share
 * one catalog and one set of line-item affordances with real inventory,
 * per the master spec's own grouping, not two parallel systems.
 */
export const productTypeEnum = pgEnum("product_type", [
  "TRACKED_INVENTORY",
  "NON_INVENTORY",
  "SERVICE",
]);

/**
 * How a `TRACKED_INVENTORY` product's unit cost is computed as purchases
 * and sales move through it. Only `WEIGHTED_AVERAGE` is implemented this
 * slice (`src/domain/inventory/costing.ts`) — see that module's doc
 * comment for why FIFO is deferred rather than half-built. This is an enum
 * (not a boolean) specifically so FIFO can be added later as a new value
 * with no column/table restructuring, the same reasoning
 * `ai_autonomy_level` documents for levels 3/4.
 */
export const inventoryCostingMethodEnum = pgEnum("inventory_costing_method", [
  "WEIGHTED_AVERAGE",
]);

/**
 * What caused an `inventory_movements` row. `PURCHASE` and `SALE` are the
 * two perpetual-inventory legs — a bought or sold `TRACKED_INVENTORY` line
 * always produces exactly one, posted (or, for `SALE`, co-posted) in the
 * same transaction as the bill/invoice it came from. `ADJUSTMENT` is a
 * manual correction (`InventoryAdjustmentService`) — stocktake correction,
 * damage, shrinkage — always carrying a `reason` and its own small journal.
 */
export const inventoryMovementTypeEnum = pgEnum("inventory_movement_type", [
  "PURCHASE",
  "SALE",
  "ADJUSTMENT",
]);

/**
 * A sellable/purchasable catalog item (master spec §20), org-scoped and
 * identified by `sku`. One implicit location per org — multi-warehouse/bin
 * tracking (master spec §20's full scope) is explicitly deferred; see
 * docs/roadmap.md. `quantityOnHand`/`averageUnitCost` are this slice's
 * perpetual-inventory state for a `TRACKED_INVENTORY` product: the
 * authoritative current balance, updated transactionally (under a row
 * lock — see `InventoryService`) by every purchase/sale/adjustment, never
 * recomputed by summing history on read. `inventory_movements` is the
 * append-only ledger of how it got there; the Inventory Valuation report
 * reconciles `quantityOnHand × averageUnitCost`, summed by
 * `inventoryAssetAccountId`, against that account's own GL balance — the
 * correctness check documented in `src/domain/inventory/valuation-service.ts`.
 *
 * Account wiring: `revenueAccountId` is always required (credited when an
 * invoice line sells this product, `TRACKED_INVENTORY` or not).
 * `NON_INVENTORY`/`SERVICE` products also require `purchaseAccountId` (the
 * expense/asset account debited when a bill line buys this product).
 * `TRACKED_INVENTORY` products instead require `inventoryAssetAccountId`
 * (debited on purchase, credited on sale — never `purchaseAccountId`,
 * which is null and unused) and `cogsAccountId` (debited, at the
 * then-current weighted-average cost, in the SAME journal entry as the
 * sale's revenue/tax lines — see `InvoiceService.approveAndPost`).
 */
export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  type: productTypeEnum("type").notNull(),
  costingMethod: inventoryCostingMethodEnum("costing_method").notNull().default("WEIGHTED_AVERAGE"),
  /** Default selling price, decimal string — a convenience the invoice-line UI may prefill; never itself authoritative over what's typed on a line. */
  sellPrice: numeric("sell_price", { precision: 19, scale: 4 }),
  revenueAccountId: uuid("revenue_account_id")
    .notNull()
    .references(() => accounts.id),
  /** Required for NON_INVENTORY/SERVICE, null and unused for TRACKED_INVENTORY — see this table's doc comment. */
  purchaseAccountId: uuid("purchase_account_id").references(() => accounts.id),
  /** Required for TRACKED_INVENTORY, null and unused otherwise. */
  inventoryAssetAccountId: uuid("inventory_asset_account_id").references(() => accounts.id),
  /** Required for TRACKED_INVENTORY, null and unused otherwise. */
  cogsAccountId: uuid("cogs_account_id").references(() => accounts.id),
  /** Current on-hand quantity, decimal string. Perpetually maintained; see this table's doc comment. Always "0" for a non-tracked product. */
  quantityOnHand: numeric("quantity_on_hand", { precision: 19, scale: 4 }).notNull().default("0"),
  /** Current weighted-average unit cost, decimal string. Always "0" for a non-tracked product. */
  averageUnitCost: numeric("average_unit_cost", { precision: 19, scale: 4 }).notNull().default("0"),
  /** Reorder alerting (master spec §21's one deterministic, non-forecasted piece — see `ReorderAlertService`). Null means "never alert" for this product. */
  reorderPoint: numeric("reorder_point", { precision: 19, scale: 4 }),
  /** Suggested quantity to reorder once below `reorderPoint` — informational only, no PO is auto-generated. */
  reorderQuantity: numeric("reorder_quantity", { precision: 19, scale: 4 }),
  preferredSupplierContactId: uuid("preferred_supplier_contact_id").references(() => contacts.id),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgSkuUnique: uniqueIndex("products_org_sku_unique").on(table.organizationId, table.sku),
  orgTypeIdx: index("products_org_type_idx").on(table.organizationId, table.type),
  orgActiveIdx: index("products_org_active_idx").on(table.organizationId, table.isActive),
  /** The exact predicate `ReorderAlertService` scans — tracked, active products with a reorder point set. */
  orgReorderIdx: index("products_org_reorder_idx").on(table.organizationId, table.type, table.isActive),
}));

/**
 * The append-only perpetual-inventory ledger for a `TRACKED_INVENTORY`
 * product — one row per purchase/sale/adjustment, in the order applied.
 * `balanceQuantityAfter`/`balanceAverageCostAfter` snapshot
 * `products.quantityOnHand`/`averageUnitCost` immediately after this row
 * was applied, purely for audit/debugging transparency (what was the
 * balance right after this specific movement) — the authoritative current
 * balance always lives on `products` itself, never recomputed by replaying
 * this table. Exactly one of `invoiceLineId`/`billLineId`/`adjustmentId` is
 * set, matching `movementType`. `journalEntryId` is the posted entry this
 * movement's value is reflected in: the invoice's own entry for a SALE
 * (the COGS/inventory-asset lines are added to it, not a separate entry),
 * the bill's own entry for a PURCHASE (its existing expense/asset debit
 * already lands on `inventoryAssetAccountId` once `BillService` resolves
 * the line's account from the product — no extra lines needed), and the
 * adjustment's own small entry for an ADJUSTMENT.
 */
export const inventoryMovements = pgTable("inventory_movements", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  movementType: inventoryMovementTypeEnum("movement_type").notNull(),
  /** Signed decimal string: positive for a PURCHASE or an increasing ADJUSTMENT, negative for a SALE or a decreasing ADJUSTMENT. */
  quantityDelta: numeric("quantity_delta", { precision: 19, scale: 4 }).notNull(),
  /** The unit cost this movement was valued at: the purchase's own unit price for PURCHASE, the weighted-average cost at the moment of sale for SALE, and either the caller's stated cost (increasing) or the current weighted-average (decreasing) for ADJUSTMENT. */
  unitCost: numeric("unit_cost", { precision: 19, scale: 4 }).notNull(),
  /** quantityDelta × unitCost, signed — the monetary value this movement added to or removed from the inventory asset account. */
  totalValue: numeric("total_value", { precision: 19, scale: 4 }).notNull(),
  balanceQuantityAfter: numeric("balance_quantity_after", { precision: 19, scale: 4 }).notNull(),
  balanceAverageCostAfter: numeric("balance_average_cost_after", { precision: 19, scale: 4 }).notNull(),
  invoiceLineId: uuid("invoice_line_id").references((): AnyPgColumn => invoiceLines.id),
  billLineId: uuid("bill_line_id").references((): AnyPgColumn => billLines.id),
  adjustmentId: uuid("adjustment_id").references((): AnyPgColumn => inventoryAdjustments.id),
  journalEntryId: uuid("journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  memo: text("memo"),
  /** The source document's own date (invoice/bill issueDate, or the adjustment's occurredAt) — not necessarily `createdAt`, same convention as `journalEntries.postingDate`. */
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  orgProductIdx: index("inventory_movements_org_product_idx").on(table.organizationId, table.productId),
  orgProductCreatedIdx: index("inventory_movements_org_product_created_idx").on(
    table.organizationId,
    table.productId,
    table.createdAt,
  ),
}));

/**
 * A manual correction to a `TRACKED_INVENTORY` product's quantity —
 * stocktake correction, damage, shrinkage (master spec §20's generic
 * adjustment; a dedicated damaged-stock workflow is deferred, see
 * docs/roadmap.md). Always carries a `reason` and always posts its own
 * small balanced journal via `PostingService` (debiting/crediting
 * `adjustmentAccountId` against the product's `inventoryAssetAccountId`),
 * exactly like every other mutation in this codebase — never a direct
 * quantity edit with no ledger effect.
 */
export const inventoryAdjustments = pgTable("inventory_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  /** Signed decimal string: positive increases on-hand quantity, negative decreases it. */
  quantityDelta: numeric("quantity_delta", { precision: 19, scale: 4 }).notNull(),
  /** The unit cost this adjustment was valued at — see `inventory_movements.unitCost`'s comment. */
  unitCost: numeric("unit_cost", { precision: 19, scale: 4 }).notNull(),
  reason: text("reason").notNull(),
  /** The expense/loss account (e.g. "Inventory Shrinkage") this adjustment's value is posted against — required, chosen by the person recording the adjustment. */
  adjustmentAccountId: uuid("adjustment_account_id")
    .notNull()
    .references(() => accounts.id),
  journalEntryId: uuid("journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  orgProductIdx: index("inventory_adjustments_org_product_idx").on(table.organizationId, table.productId),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [products.organizationId],
    references: [organizations.id],
  }),
  revenueAccount: one(accounts, {
    fields: [products.revenueAccountId],
    references: [accounts.id],
  }),
  preferredSupplier: one(contacts, {
    fields: [products.preferredSupplierContactId],
    references: [contacts.id],
  }),
  movements: many(inventoryMovements),
}));

export const inventoryMovementsRelations = relations(inventoryMovements, ({ one }) => ({
  organization: one(organizations, {
    fields: [inventoryMovements.organizationId],
    references: [organizations.id],
  }),
  product: one(products, {
    fields: [inventoryMovements.productId],
    references: [products.id],
  }),
}));

export const inventoryAdjustmentsRelations = relations(inventoryAdjustments, ({ one }) => ({
  organization: one(organizations, {
    fields: [inventoryAdjustments.organizationId],
    references: [organizations.id],
  }),
  product: one(products, {
    fields: [inventoryAdjustments.productId],
    references: [products.id],
  }),
}));

// ---------------------------------------------------------------------------
// Phase 7 Slice 3 — Fixed Assets (master spec §28)
// ---------------------------------------------------------------------------

/**
 * How a fixed asset's depreciable base is expensed over its useful life.
 * Only `STRAIGHT_LINE` is implemented this slice — see
 * `src/domain/fixed-assets/depreciation.ts`'s doc comment for why
 * declining-balance and the other master-spec-§28 methods (units-of-
 * production, sum-of-years-digits) are deferred rather than half-built.
 * An enum (not a boolean), same reasoning as `inventoryCostingMethodEnum`,
 * so a second method can be added later with no column restructuring.
 */
export const depreciationMethodEnum = pgEnum("depreciation_method", ["STRAIGHT_LINE"]);

/**
 * A fixed asset's lifecycle. `ACTIVE` depreciates every period it's run for;
 * `DISPOSED` (sold, with proceeds) and `WRITTEN_OFF` (no proceeds) are both
 * terminal and one-way — see `FixedAssetService.disposeAsset`/`writeOffAsset`'s
 * doc comments for why correcting one is a correcting journal, never an edit.
 */
export const fixedAssetStatusEnum = pgEnum("fixed_asset_status", [
  "ACTIVE",
  "DISPOSED",
  "WRITTEN_OFF",
]);

/**
 * A simple per-org lookup/template for a category of fixed asset (e.g.
 * "Motor Vehicles" / 60 months / straight-line, "Computer Equipment" / 36
 * months / straight-line) — master spec §28's "asset class", deliberately
 * kept this simple rather than a full depreciation-policy engine. Registering
 * an asset copies `defaultUsefulLifeMonths`/`defaultDepreciationMethod` onto
 * the asset's own columns (both overridable per-asset at registration time),
 * exactly like `products.costingMethod` defaulting from the (single-value)
 * enum — the class is a convenience prefill, never re-consulted afterwards,
 * so changing a class's defaults never retroactively changes an already
 * registered asset's depreciation.
 */
export const fixedAssetClasses = pgTable("fixed_asset_classes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  defaultDepreciationMethod: depreciationMethodEnum("default_depreciation_method")
    .notNull()
    .default("STRAIGHT_LINE"),
  /** Useful life in whole months — see `fixedAssets.usefulLifeMonths`'s comment for why months, not years, is this slice's one consistent unit. */
  defaultUsefulLifeMonths: integer("default_useful_life_months").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgNameIdx: index("fixed_asset_classes_org_name_idx").on(table.organizationId, table.name),
  orgActiveIdx: index("fixed_asset_classes_org_active_idx").on(table.organizationId, table.isActive),
}));

/**
 * One capitalized fixed asset (master spec §28), org-scoped. This is a
 * subsidiary register, not a source of new GL postings for the acquisition
 * itself: `FixedAssetService.registerAsset`/`registerFromBillLine` never
 * post anything — the designated `assetAccountId`'s balance must already
 * reflect the acquisition, either because a bill line was coded directly to
 * it (the normal path; see `registerFromBillLine`'s doc comment for why
 * that needs no new "purchase" plumbing) or via a manual journal/opening-
 * balance import (the standalone path). `FixedAssetRegisterService`
 * reconciles the register's total net book value against
 * `assetAccountId`/`accumulatedDepreciationAccountId`'s own GL balances —
 * the same correctness-check spirit as `InventoryValuationService`, see
 * that module's doc comment and `docs/accounting-engine.md` §10/§11.
 *
 * `accumulatedDepreciation` is this asset's perpetually-maintained running
 * total (like `products.quantityOnHand`), updated only by
 * `DepreciationService.runForPeriod` and `disposeAsset`/`writeOffAsset` —
 * `depreciation_entries` is the append-only audit trail of how it got
 * there, never recomputed by summing history on read.
 *
 * Useful life is stored in **months**, the one consistent unit this slice
 * uses throughout (straight-line's per-period amount is simplest expressed
 * as a monthly charge, and it lets a sub-year useful life — e.g. a 18-month
 * leased fit-out — be represented exactly, which "useful life in years"
 * cannot).
 */
export const fixedAssets = pgTable("fixed_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  assetClassId: uuid("asset_class_id")
    .notNull()
    .references(() => fixedAssetClasses.id),
  name: text("name").notNull(),
  description: text("description"),
  acquisitionDate: timestamp("acquisition_date", { withTimezone: true, mode: "date" }).notNull(),
  acquisitionCost: numeric("acquisition_cost", { precision: 19, scale: 4 }).notNull(),
  usefulLifeMonths: integer("useful_life_months").notNull(),
  depreciationMethod: depreciationMethodEnum("depreciation_method").notNull().default("STRAIGHT_LINE"),
  /** Decimal string, >= 0 and < acquisitionCost — the value never depreciated away. Defaults to "0". */
  residualValue: numeric("residual_value", { precision: 19, scale: 4 }).notNull().default("0"),
  status: fixedAssetStatusEnum("status").notNull().default("ACTIVE"),
  /** The ASSET-type GL account this asset's cost sits in (e.g. "Motor Vehicles — Cost"). Debited at acquisition (elsewhere — see this table's doc comment), credited for the remaining cost at disposal/write-off. */
  assetAccountId: uuid("asset_account_id")
    .notNull()
    .references(() => accounts.id),
  /** The contra-asset GL account depreciation accumulates into (e.g. "Accumulated Depreciation — Motor Vehicles"). Modeled as an ordinary ASSET-type account carrying a credit balance, the same convention `InventoryValuationService`'s reconciliation relies on for a normal-signed balance to come out negative. */
  accumulatedDepreciationAccountId: uuid("accumulated_depreciation_account_id")
    .notNull()
    .references(() => accounts.id),
  /** The EXPENSE-type GL account each period's depreciation charge debits. */
  depreciationExpenseAccountId: uuid("depreciation_expense_account_id")
    .notNull()
    .references(() => accounts.id),
  /** Perpetually-maintained running total, decimal string — see this table's doc comment. Always "0" for a brand-new asset. Capped at `acquisitionCost - residualValue`; never exceeds it regardless of how many periods are run. */
  accumulatedDepreciation: numeric("accumulated_depreciation", { precision: 19, scale: 4 }).notNull().default("0"),
  /** Free-text physical location or custody reference (master spec §28). A plain editable field, not a tracked transfer workflow — see docs/roadmap.md. */
  locationReference: text("location_reference"),
  serialNumber: text("serial_number"),
  /** Set when this asset was registered from a posted bill line (`registerFromBillLine`) — traceability only, never re-read to post anything. Null for a standalone registration. */
  sourceBillLineId: uuid("source_bill_line_id").references((): AnyPgColumn => billLines.id),
  disposedAt: timestamp("disposed_at", { withTimezone: true, mode: "date" }),
  /** Decimal string — cash/other consideration received on a sale disposal. Null for a WRITTEN_OFF asset (no proceeds by definition) and for an asset still ACTIVE. */
  disposalProceeds: numeric("disposal_proceeds", { precision: 19, scale: 4 }),
  /** Signed decimal string: proceeds − net book value at disposal. Positive = gain, negative = loss. For a write-off this is always −(net book value) — a full loss, no proceeds. Null while ACTIVE. */
  disposalGainLoss: numeric("disposal_gain_loss", { precision: 19, scale: 4 }),
  disposalJournalEntryId: uuid("disposal_journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgStatusIdx: index("fixed_assets_org_status_idx").on(table.organizationId, table.status),
  orgClassIdx: index("fixed_assets_org_class_idx").on(table.organizationId, table.assetClassId),
  orgAssetAccountIdx: index("fixed_assets_org_asset_account_idx").on(table.organizationId, table.assetAccountId),
}));

/**
 * The append-only per-period depreciation audit trail for one fixed asset —
 * one row per (asset, calendar month) run of `DepreciationService.runForPeriod`,
 * in period order. `periodStart`/`periodEnd` are the first/last calendar day
 * of the month depreciated (UTC); the unique index on
 * (`organizationId`, `assetId`, `periodStart`) is this slice's idempotency
 * guarantee — see that service's doc comment — re-running the same month
 * for the same asset is a structural no-op, not just a convention. A $0
 * row (an asset not yet acquired as of this period, or already fully
 * depreciated) is still inserted, so the "has this asset/period already
 * been run" check never needs to reason about amount, only existence.
 * `journalEntryId` is null for a $0 row (nothing to post) and otherwise
 * points at the one combined journal entry
 * `DepreciationService.runForPeriod` posts for the whole run (a line pair
 * per non-zero asset) — never a separate entry per asset, see that
 * service's doc comment.
 */
export const depreciationEntries = pgTable("depreciation_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => fixedAssets.id),
  periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
  /** Decimal string, >= 0. This period's depreciation charge for this asset — "0" when not yet acquired or already fully depreciated. */
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  /** Snapshot of `fixedAssets.accumulatedDepreciation` immediately after this row — audit/debugging transparency, same convention as `inventory_movements.balanceQuantityAfter`. */
  accumulatedDepreciationAfter: numeric("accumulated_depreciation_after", { precision: 19, scale: 4 }).notNull(),
  journalEntryId: uuid("journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  orgAssetPeriodUnique: uniqueIndex("depreciation_entries_org_asset_period_unique").on(
    table.organizationId,
    table.assetId,
    table.periodStart,
  ),
  orgAssetIdx: index("depreciation_entries_org_asset_idx").on(table.organizationId, table.assetId),
}));

export const fixedAssetClassesRelations = relations(fixedAssetClasses, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [fixedAssetClasses.organizationId],
    references: [organizations.id],
  }),
  assets: many(fixedAssets),
}));

export const fixedAssetsRelations = relations(fixedAssets, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [fixedAssets.organizationId],
    references: [organizations.id],
  }),
  assetClass: one(fixedAssetClasses, {
    fields: [fixedAssets.assetClassId],
    references: [fixedAssetClasses.id],
  }),
  assetAccount: one(accounts, {
    fields: [fixedAssets.assetAccountId],
    references: [accounts.id],
  }),
  accumulatedDepreciationAccount: one(accounts, {
    fields: [fixedAssets.accumulatedDepreciationAccountId],
    references: [accounts.id],
  }),
  depreciationExpenseAccount: one(accounts, {
    fields: [fixedAssets.depreciationExpenseAccountId],
    references: [accounts.id],
  }),
  entries: many(depreciationEntries),
}));

export const depreciationEntriesRelations = relations(depreciationEntries, ({ one }) => ({
  organization: one(organizations, {
    fields: [depreciationEntries.organizationId],
    references: [organizations.id],
  }),
  asset: one(fixedAssets, {
    fields: [depreciationEntries.assetId],
    references: [fixedAssets.id],
  }),
}));

// ---------------------------------------------------------------------------
// Phase 8 Slice 1 — AU Payroll foundation (master spec §24, §8, §26)
// ---------------------------------------------------------------------------

/**
 * A jurisdiction's tax/super rule set is NOT organization-scoped — it is
 * shared regulatory reference data, the same way the tax code system itself
 * (`tax_codes`, which IS org-scoped because each org edits its own GST
 * setup) differs from a withholding rate nobody but a regulator sets. No
 * `organization_id` column means these two tables are correctly exempt from
 * the tenant-isolation audit in src/db/migrate.ts (it only requires RLS on
 * tables that carry one) — every org reads the exact same AU rule sets.
 *
 * `jurisdiction` is a free-text code (just "AU" for now) rather than an enum
 * so a future state/country can be added with a data row, not a migration —
 * master spec §26's jurisdiction-plus-effective-date architecture, built
 * here for AU only per this slice's scope.
 *
 * Effective-dated and non-overlapping per jurisdiction by convention (not a
 * DB constraint — two rows for the same jurisdiction must not have
 * overlapping [effectiveFrom, effectiveTo] ranges; `TaxRuleService.resolve`
 * is what a bad seed would silently break, so this is exercised directly by
 * unit tests rather than relied upon as an invariant the schema enforces).
 *
 * `sgQuarterlyContributionBaseCap` is nullable for a reason that must stay
 * visible here: the FY2026-27 row's cadence/cap mechanics under the ATO's
 * emerging "Payday Super" reform were NOT fully resolved during this
 * slice's research (see docs/roadmap.md's Phase 8 Slice 1 section). This
 * slice deliberately still applies the FY2025-26 quarterly-cap *mechanism*
 * at the unchanged 12% rate for FY2026-27 too (the rate itself did not
 * change), but `requiresVerificationNote` records, in the data itself —
 * not just in a comment that could rot — that a registered tax agent or
 * payroll provider must confirm the correct mechanics before this rule set
 * is used for real FY2026-27 payroll.
 */
export const payrollTaxRuleSets = pgTable("payroll_tax_rule_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  jurisdiction: text("jurisdiction").notNull(),
  /** Human label, e.g. "FY2025-26" — display/debugging only, never matched on. */
  label: text("label").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }).notNull(),
  /** Inclusive end date. Null would mean "open-ended" but every seeded row has one — AU financial years are exactly bounded. */
  effectiveTo: timestamp("effective_to", { withTimezone: true, mode: "date" }).notNull(),
  /** Decimal string, e.g. "0.02" for 2%. Source: ato.gov.au — see docs/roadmap.md for the citation. */
  medicareLevyRate: numeric("medicare_levy_rate", { precision: 6, scale: 4 }).notNull(),
  /** Decimal string — below this ANNUAL taxable income, nil Medicare levy. Singles threshold only (no family threshold modeling in this slice). */
  medicareLevyLowerThreshold: numeric("medicare_levy_lower_threshold", { precision: 19, scale: 4 }).notNull(),
  /** Decimal string — at/above this ANNUAL taxable income, the full standard rate applies. Between the two thresholds, `PaygCalculations` applies the documented (non-ATO-verified) 10%-phase-in formula — see that module's doc comment. */
  medicareLevyUpperThreshold: numeric("medicare_levy_upper_threshold", { precision: 19, scale: 4 }).notNull(),
  /** Decimal string, e.g. "0.12" for 12%. Source: ato.gov.au "Super guarantee" page. */
  sgRate: numeric("sg_rate", { precision: 6, scale: 4 }).notNull(),
  /** Decimal string — quarterly OTE cap above which SG is not mandatory. Null only for a rule set whose cadence/cap mechanics are themselves unresolved (see this table's doc comment) — `SuperCalculations` must treat null as "do not fabricate a cap", never silently fall back to a default. */
  sgQuarterlyContributionBaseCap: numeric("sg_quarterly_contribution_base_cap", { precision: 19, scale: 4 }),
  /** Phase 8 Slice 4(g): `QUARTERLY` (the long-standing cadence; also the labelled LEGACY path) or `PAYDAY` (Payday Super: SG per payday, annual contribution base). */
  sgCadence: text("sg_cadence").notNull().default("QUARTERLY"),
  /** Phase 8 Slice 4(g): the ANNUAL maximum contribution base used by a `PAYDAY` rule set ($270,830 for 2026-27). Null for QUARTERLY rule sets. */
  sgAnnualContributionBaseCap: numeric("sg_annual_contribution_base_cap", { precision: 19, scale: 4 }),
  /** Phase 8 Slice 4: new regulatory understanding is added as a NEW VERSION covering the same dates, never by editing a seeded row. The resolver picks the highest version unless the legacy path is asked for. */
  version: integer("version").notNull().default(1),
  /** Non-null flags that this specific rule set has a known-unresolved regulatory detail (the FY2026-27 Payday Super cadence) that a tax agent must confirm before real payroll relies on it — surfaced in the STP-shaped report and payslip UI, not buried in a comment only developers see. */
  requiresVerificationNote: text("requires_verification_note"),
  /** Free text recording where each figure on this row came from — reproduced in docs/roadmap.md too, but kept here as well so the data is self-documenting if the docs ever drift. */
  sourceCitation: text("source_citation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  jurisdictionRangeIdx: index("payroll_tax_rule_sets_jurisdiction_idx").on(table.jurisdiction, table.effectiveFrom),
  rangeVersionUnique: uniqueIndex("payroll_tax_rule_sets_range_version_unique").on(table.jurisdiction, table.effectiveFrom, table.version),
  cadenceCheck: check("payroll_tax_rule_sets_cadence_check", sql`${table.sgCadence} IN ('QUARTERLY', 'PAYDAY')`),
}));

/**
 * One marginal-rate row of a resident individual income tax schedule
 * (master spec §24). `threshold` is the lower bound this `marginalRate`
 * first applies to a dollar earned above (the classic "$18,201–$45,000:
 * 16%" row has `threshold = "18200.0000"`, `marginalRate = "0.1600"`).
 *
 * Deliberately NOT storing a "cumulative base amount" column (the "$4,020
 * plus 30% of the excess over $45,000" figure) — `BracketCalculations.
 * cumulativeBaseAt` derives it from the ordered set of
 * (threshold, marginalRate) rows below any given bracket, at read time, so
 * the $4,020/$31,020/$51,370 figures this slice was handed are independently
 * *reproduced*, not merely trusted — see that module's unit tests, which
 * treat a mismatch as a bug in the verified input figures to investigate,
 * never something to "fix" by changing the source numbers.
 */
export const payrollTaxBrackets = pgTable("payroll_tax_brackets", {
  id: uuid("id").primaryKey().defaultRandom(),
  ruleSetId: uuid("rule_set_id")
    .notNull()
    .references(() => payrollTaxRuleSets.id, { onDelete: "cascade" }),
  /** 0-based ordering within the rule set — brackets must be evaluated lowest-threshold-first for the cumulative-base derivation to be correct. */
  sequence: integer("sequence").notNull(),
  /** Decimal string — the lower bound of annual taxable income this marginal rate first applies above. */
  threshold: numeric("threshold", { precision: 19, scale: 4 }).notNull(),
  /** Decimal string, e.g. "0.3000" for 30%. */
  marginalRate: numeric("marginal_rate", { precision: 6, scale: 4 }).notNull(),
  /** Phase 8 Slice 4(c): `RESIDENT` (the original schedule) or `FOREIGN_RESIDENT` (no tax-free threshold). */
  category: text("category").notNull().default("RESIDENT"),
}, (table) => ({
  ruleSetCategorySequenceUnique: uniqueIndex("payroll_tax_brackets_rule_set_category_sequence_unique").on(table.ruleSetId, table.category, table.sequence),
  categoryCheck: check("payroll_tax_brackets_category_check", sql`${table.category} IN ('RESIDENT', 'FOREIGN_RESIDENT')`),
}));

export const employmentBasisEnum = pgEnum("employment_basis", ["SALARY", "HOURLY"]);

export const payFrequencyEnum = pgEnum("pay_frequency", ["WEEKLY", "FORTNIGHTLY", "MONTHLY"]);

export const employeeStatusEnum = pgEnum("employee_status", ["ACTIVE", "TERMINATED"]);

/**
 * An org's payroll employee record — deliberately its own table, not a
 * repurposed `contacts` row. `contacts` models an external party Money
 * Matters sends invoices/bills to or pays through AP; an employee has a
 * different shape entirely (TFN, super fund, a pay basis/rate, leave
 * balances) and different sensitivity (TFN is as sensitive as a password —
 * see this table's `tfn` column comment), so folding payroll fields onto
 * `contacts` would mean every contact-reading code path in the app
 * (invoices, bills, the AI Controller's read-only tools) has to reason
 * about whether a `contacts` row might also be carrying a TFN. A separate
 * table keeps that blast radius at exactly the payroll domain. `userId` is
 * an OPTIONAL link to a Money Matters login — only employees who also log
 * in to submit timesheets (the HOURLY path that sources hours from
 * `TimesheetService`/`timesheet_entries.employee_user_id`) need one; a
 * SALARY employee with no system access at all is still a fully valid
 * payroll record.
 */
export const employees = pgTable("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Optional link to a `users` row — see this table's doc comment. Required (enforced in `EmployeeService`, not the schema) for an HOURLY employee whose gross pay is meant to be sourced from approved timesheets rather than manually entered hours. */
  userId: uuid("user_id").references(() => users.id),
  name: text("name").notNull(),
  employmentBasis: employmentBasisEnum("employment_basis").notNull(),
  /** Decimal string, annual gross — required and only meaningful for SALARY. Null for HOURLY. */
  annualSalary: numeric("annual_salary", { precision: 19, scale: 4 }),
  /** Decimal string, per hour — required and only meaningful for HOURLY. Null for SALARY. */
  hourlyRate: numeric("hourly_rate", { precision: 19, scale: 4 }),
  /** Decimal string, e.g. "38.00" — used to pro-rate NES leave accrual for a part-time employee against the 38-hour/152-hour(annual leave)/76-hour(personal leave) full-time NES figures. */
  standardHoursPerWeek: numeric("standard_hours_per_week", { precision: 6, scale: 2 }).notNull().default("38.00"),
  payFrequency: payFrequencyEnum("pay_frequency").notNull(),
  /** Whether this employee has claimed the tax-free threshold on their (not separately modeled) TFN declaration — the one flag this slice reads; see `PaygCalculations`'s doc comment for what "not claimed" approximates and does not attempt. */
  taxFreeThresholdClaimed: boolean("tax_free_threshold_claimed").notNull().default(true),
  /** Phase 8 Slice 4(c): `RESIDENT` or `FOREIGN_RESIDENT` for tax purposes. A foreign resident is withheld at the foreign resident rates (approximation) with no Medicare levy. */
  taxResidency: text("tax_residency").notNull().default("RESIDENT"),
  startDate: timestamp("start_date", { withTimezone: true, mode: "date" }).notNull(),
  terminationDate: timestamp("termination_date", { withTimezone: true, mode: "date" }),
  status: employeeStatusEnum("status").notNull().default("ACTIVE"),
  /**
   * Tax file number — treated with the same sensitivity as a password
   * throughout this codebase (master spec §8/§44): `AuditService.
   * REDACTED_FIELDS` redacts the key `tfn` the same way it redacts
   * `password`/`secret`/`token`, so no audit-log row (before/after
   * snapshot) ever stores the real value, and every UI surface below
   * OWNER/ADMINISTRATOR/PAYROLL_MANAGER shows only `maskTfn()`'s
   * last-4-digit form (`src/domain/payroll/sensitive-data.ts`) — never the
   * full value. Nullable because capturing it is a real-world onboarding
   * step that can lag behind creating the employee record itself.
   */
  tfn: text("tfn"),
  superFundName: text("super_fund_name"),
  superFundAbn: text("super_fund_abn"),
  superMemberAccountNumber: text("super_member_account_number"),
  /** Record-keeping only — no SuperStream remittance integration and no real bank-file payment generation in this slice, same deliberate boundary `PaymentRunService`'s payment step already draws for supplier payments. */
  bankAccountName: text("bank_account_name"),
  bankBsb: text("bank_bsb"),
  bankAccountNumber: text("bank_account_number"),
  /** Perpetually-maintained running balance, hours — same convention as `fixedAssets.accumulatedDepreciation`: updated only by `PayRunService.runPayRun`, with `pay_run_lines` as the append-only trail of how it got there. */
  annualLeaveBalanceHours: numeric("annual_leave_balance_hours", { precision: 10, scale: 4 }).notNull().default("0"),
  personalLeaveBalanceHours: numeric("personal_leave_balance_hours", { precision: 10, scale: 4 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgStatusIdx: index("employees_org_status_idx").on(table.organizationId, table.status),
  orgUserIdx: index("employees_org_user_idx").on(table.organizationId, table.userId),
}));

/** `REVERSED` (Phase 8 Slice 3): a POSTED run whose journal was reversed; terminal. Its lines are kept as history. */
export const payRunStatusEnum = pgEnum("pay_run_status", ["DRAFT", "POSTED", "REVERSED"]);

/**
 * One on-demand "run payroll for period X" action (master spec §8) — the
 * payroll mirror of `RecurringInvoiceService.generateDue`/
 * `DepreciationService.runForPeriod`: human-triggered, never scheduled (no
 * job queue exists in this codebase — see docs/roadmap.md). `DRAFT` holds
 * every computed `pay_run_lines` row for review; `POSTED` is terminal and
 * immutable like any other posted journal — see `PayRunService.post`'s doc
 * comment for why a mistake after posting is a reversing journal, never an
 * edit to this row or its lines.
 */
export const payRuns = pgTable("pay_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  payFrequency: payFrequencyEnum("pay_frequency").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
  payDate: timestamp("pay_date", { withTimezone: true, mode: "date" }).notNull(),
  status: payRunStatusEnum("status").notNull().default("DRAFT"),
  /** GL account wiring, chosen at `create()` time and frozen for this run — same convention as `fixedAssets`' own account columns. See `PayRunService.post`'s doc comment for which side of the journal each one lands on. */
  wagesExpenseAccountId: uuid("wages_expense_account_id")
    .notNull()
    .references(() => accounts.id),
  superannuationExpenseAccountId: uuid("superannuation_expense_account_id")
    .notNull()
    .references(() => accounts.id),
  paygWithholdingPayableAccountId: uuid("payg_withholding_payable_account_id")
    .notNull()
    .references(() => accounts.id),
  superannuationPayableAccountId: uuid("superannuation_payable_account_id")
    .notNull()
    .references(() => accounts.id),
  /** Credited for net pay (master spec §8) — this slice models a pay run's net pay as an immediately-recognized liability, the same "posted vs paid" separation `PaymentRunService` already draws for supplier payments: this account is a NET WAGES PAYABLE liability, not a bank account, so a pay run posting never claims an actual bank transfer happened (no real bank-file payment generation exists here, mirroring `PaymentRunService`'s own payment step). Settling it is a separate manual payment, exactly like paying down any other payable. */
  netWagesPayableAccountId: uuid("net_wages_payable_account_id")
    .notNull()
    .references(() => accounts.id),
  /** The one combined payroll journal entry posted at `post()` time — see `PayRunService.post`'s doc comment for the debit/credit lines. Null while DRAFT. */
  journalEntryId: uuid("journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  postedById: uuid("posted_by_id"),
  /** Phase 8 Slice 3: set once when `PayRunService.reverse` reverses the posting journal; the original lines are never edited. */
  reversalJournalEntryId: uuid("reversal_journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  reversedById: uuid("reversed_by_id"),
  reversalReason: text("reversal_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  orgStatusIdx: index("pay_runs_org_status_idx").on(table.organizationId, table.status),
  // A DRAFT or POSTED run for the same employee set isn't deduplicated by the
  // schema (unlike depreciation_entries' per-asset-per-month uniqueness) —
  // `PayRunService.create` is where accidental double-running the same
  // period for the same employee is refused; see that method's doc comment.
  orgPeriodIdx: index("pay_runs_org_period_idx").on(table.organizationId, table.periodStart, table.periodEnd),
}));

/**
 * One employee's computed pay within a `pay_runs` row — the append-only
 * detail line this slice's payslip view and STP-shaped report both read.
 * Every monetary/hours figure here is a decimal string, computed once at
 * `PayRunService.create` time and frozen; `PayRunService.post` only ever
 * reads these rows to build the one combined journal, never recomputes
 * them (so the GL and the payslip always agree by construction).
 *
 * `taxRuleSetId` records exactly which effective-dated rule set produced
 * `paygWithholding`/`superGuarantee` on this row — the auditable proof that
 * "effective-date controlled" (master spec §26) actually determined the
 * numbers, not just documentation claiming it does.
 */
export const payRunLines = pgTable("pay_run_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  payRunId: uuid("pay_run_id")
    .notNull()
    .references(() => payRuns.id, { onDelete: "cascade" }),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id),
  taxRuleSetId: uuid("tax_rule_set_id")
    .notNull()
    .references(() => payrollTaxRuleSets.id),
  /** Decimal string — hours this pay run paid for. "0" for a SALARY employee not pro-rated by hours (still recorded, for display). */
  hoursPaid: numeric("hours_paid", { precision: 10, scale: 4 }).notNull().default("0"),
  /** Decimal string. */
  grossPay: numeric("gross_pay", { precision: 19, scale: 4 }).notNull(),
  /** Decimal string — this slice's one OTE simplification: all of `grossPay` is treated as ordinary time earnings for SG purposes (no overtime/bonus OTE-exclusion modeling) — see docs/roadmap.md. */
  ordinaryTimeEarnings: numeric("ordinary_time_earnings", { precision: 19, scale: 4 }).notNull(),
  /** Decimal string — this employee's quarter-to-date OTE INCLUDING this run, after applying the quarterly contribution base cap logic — see `SuperCalculations.quarterlyOte`'s doc comment. Recorded so the next pay run in the same quarter can read it back rather than re-deriving it by re-summing every prior run. */
  quarterToDateOte: numeric("quarter_to_date_ote", { precision: 19, scale: 4 }).notNull(),
  /** Decimal string. */
  paygWithholding: numeric("payg_withholding", { precision: 19, scale: 4 }).notNull(),
  /** Decimal string — superGuarantee = sgRate × (this run's OTE actually subject to SG after the quarterly cap, which may be less than ordinaryTimeEarnings if the cap was reached mid-run). */
  superGuarantee: numeric("super_guarantee", { precision: 19, scale: 4 }).notNull(),
  /** Decimal string. grossPay − paygWithholding (this slice pays no other employee-side deductions). */
  netPay: numeric("net_pay", { precision: 19, scale: 4 }).notNull(),
  /** Decimal string — NES annual leave accrued by this run (master spec §25). */
  annualLeaveAccrued: numeric("annual_leave_accrued", { precision: 10, scale: 4 }).notNull(),
  /** Decimal string — NES personal/carer's leave accrued by this run. */
  personalLeaveAccrued: numeric("personal_leave_accrued", { precision: 10, scale: 4 }).notNull(),
  /** Phase 8 Slice 3: hours of APPROVED leave requests deducted from the balance when this run is POSTED (selected at create(), frozen). Balance-only: gross pay is NOT changed by it. */
  annualLeaveTaken: numeric("annual_leave_taken", { precision: 10, scale: 4 }).notNull().default("0"),
  personalLeaveTaken: numeric("personal_leave_taken", { precision: 10, scale: 4 }).notNull().default("0"),
  /** Phase 8 Slice 3: the employee's leave balances immediately after this run posted (for the payslip). NULL on a DRAFT and on runs posted before this column existed. */
  /** Phase 8 Slice 4(g): which SG cadence produced this line (`QUARTERLY` legacy or `PAYDAY`). Under PAYDAY, `quarter_to_date_ote` holds the financial-year-to-date figure. */
  superCadence: text("super_cadence").notNull().default("QUARTERLY"),
  /** Phase 8 Slice 4(g): conservative date by which the fund should have RECEIVED this line's SG (PAYDAY only): six weekdays after payday. Not the legal deadline. */
  superSafeByDate: timestamp("super_safe_by_date", { withTimezone: true, mode: "date" }),
  annualLeaveBalanceAfter: numeric("annual_leave_balance_after", { precision: 10, scale: 4 }),
  personalLeaveBalanceAfter: numeric("personal_leave_balance_after", { precision: 10, scale: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgPayRunIdx: index("pay_run_lines_org_pay_run_idx").on(table.organizationId, table.payRunId),
  orgEmployeeIdx: index("pay_run_lines_org_employee_idx").on(table.organizationId, table.employeeId),
  payRunEmployeeUnique: uniqueIndex("pay_run_lines_pay_run_employee_unique").on(table.payRunId, table.employeeId),
}));

export const leaveTypeEnum = pgEnum("leave_type", ["ANNUAL", "PERSONAL"]);
export const leaveRequestStatusEnum = pgEnum("leave_request_status", ["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);

/**
 * Phase 8 Slice 3: a leave request. An employee (an `employees` row linked by `user_id` to the requester) asks for hours
 * of ANNUAL or PERSONAL leave; someone else with `leave:approve` decides it (never the requester). An APPROVED request is
 * deducted from the employee's balance when the next pay run covering its start date is POSTED (`applied_pay_run_id` is
 * then set; reversing that run unsets it). The hours are entered by the requester - no public-holiday or roster logic.
 */
export const leaveRequests = pgTable("leave_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id),
  leaveType: leaveTypeEnum("leave_type").notNull(),
  startDate: timestamp("start_date", { withTimezone: true, mode: "date" }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true, mode: "date" }).notNull(),
  hours: numeric("hours", { precision: 10, scale: 4 }).notNull(),
  reason: text("reason"),
  status: leaveRequestStatusEnum("status").notNull().default("PENDING"),
  requestedById: uuid("requested_by_id").notNull(),
  decidedById: uuid("decided_by_id"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  appliedPayRunId: uuid("applied_pay_run_id").references((): AnyPgColumn => payRuns.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgEmployeeIdx: index("leave_requests_org_employee_idx").on(table.organizationId, table.employeeId),
  orgStatusIdx: index("leave_requests_org_status_idx").on(table.organizationId, table.status),
  hoursPositive: check("leave_requests_hours_positive", sql`${table.hours} > 0`),
  dateOrder: check("leave_requests_date_order", sql`${table.endDate} >= ${table.startDate}`),
}));

export const payrollPaymentKindEnum = pgEnum("payroll_payment_kind", ["NET_WAGES", "SUPER", "PAYG"]);
export const payrollPaymentStatusEnum = pgEnum("payroll_payment_status", ["POSTED", "REVERSED"]);

/**
 * Phase 8 Slice 3: money paid OUT against a payroll liability, posted through PostingService (Dr liability / Cr bank).
 * NET_WAGES settles a pay run's Net Wages Payable; SUPER and PAYG are RECORD-ONLY remittance entries against
 * Superannuation Payable / PAYG Withholding Payable (no clearing house, no ATO payment, no bank transfer is made by
 * Money Matters). A REVERSED payment keeps its row; the ledger effect is undone by a reversing journal.
 */
export const payrollPayments = pgTable("payroll_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  kind: payrollPaymentKindEnum("kind").notNull(),
  /** Required for NET_WAGES; null for SUPER / PAYG, which settle the liability account as a whole. */
  payRunId: uuid("pay_run_id").references((): AnyPgColumn => payRuns.id),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  paymentDate: timestamp("payment_date", { withTimezone: true, mode: "date" }).notNull(),
  /** The liability account debited (the pay run's Net Wages / Super / PAYG payable account). */
  liabilityAccountId: uuid("liability_account_id")
    .notNull()
    .references(() => accounts.id),
  /** The bank (asset) GL account credited. */
  bankAccountId: uuid("bank_account_id")
    .notNull()
    .references(() => accounts.id),
  reference: text("reference"),
  status: payrollPaymentStatusEnum("status").notNull().default("POSTED"),
  journalEntryId: uuid("journal_entry_id")
    .notNull()
    .references((): AnyPgColumn => journalEntries.id),
  reversalJournalEntryId: uuid("reversal_journal_entry_id").references((): AnyPgColumn => journalEntries.id),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  reversedById: uuid("reversed_by_id"),
  reversalReason: text("reversal_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id").notNull(),
}, (table) => ({
  orgKindIdx: index("payroll_payments_org_kind_idx").on(table.organizationId, table.kind, table.status),
  orgPayRunIdx: index("payroll_payments_org_pay_run_idx").on(table.organizationId, table.payRunId),
  amountPositive: check("payroll_payments_amount_positive", sql`${table.amount} > 0`),
}));

export const employeesRelations = relations(employees, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [employees.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [employees.userId],
    references: [users.id],
  }),
  payRunLines: many(payRunLines),
}));

/**
 * Phase 8 Slice 2: a prepared Business Activity Statement. PREPARATION ONLY - nothing is ever transmitted to the ATO.
 * A DRAFT is recomputed live from the posted ledger/sub-ledger every time it is viewed; FINALISE (a human, `bas:finalise`)
 * snapshots the full report into `report` with a SHA-256 `content_hash` and the row becomes immutable (enforced by the
 * RLS UPDATE policy, which only matches DRAFT rows, and by the absence of any DELETE on a finalised row).
 */
export const basStatements = pgTable("bas_statements", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
  frequency: basFrequencyEnum("frequency").notNull(),
  /** Only ACCRUAL is supported; CASH is refused (fail closed) - see docs/accounting-engine.md. */
  basis: text("basis").notNull().default("ACCRUAL"),
  status: basStatusEnum("status").notNull().default("DRAFT"),
  /** Human note (e.g. which agent will review). */
  note: text("note"),
  /** Snapshot of the full prepared report, set only at FINALISE. */
  report: jsonb("report"),
  contentHash: text("content_hash"),
  /** True when the human finalised with outstanding warnings (unclassified amounts, unlocked period) acknowledged. */
  warningsAcknowledged: boolean("warnings_acknowledged").notNull().default(false),
  periodLockAtFinalise: text("period_lock_at_finalise"),
  finalisedAt: timestamp("finalised_at", { withTimezone: true }),
  finalisedById: uuid("finalised_by_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
}, (table) => ({
  orgPeriodIdx: index("bas_statements_org_period_idx").on(table.organizationId, table.periodStart),
  idOrgUnique: uniqueIndex("bas_statements_id_org_unique").on(table.id, table.organizationId),
  periodOrder: check("bas_statements_period_order", sql`${table.periodEnd} >= ${table.periodStart}`),
}));

/**
 * APPEND-ONLY record that a finalised BAS was lodged OUTSIDE Money Matters (by the business or its registered agent).
 * Money Matters does not lodge anything and cannot verify the reference; this is a bookkeeping note only.
 */
export const basLodgementRecords = pgTable("bas_lodgement_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  basStatementId: uuid("bas_statement_id")
    .notNull()
    .references(() => basStatements.id),
  lodgedOn: timestamp("lodged_on", { withTimezone: true, mode: "date" }).notNull(),
  reference: text("reference").notNull(),
  recordedById: uuid("recorded_by_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  statementIdx: index("bas_lodgement_records_statement_idx").on(table.organizationId, table.basStatementId),
}));

export const payRunsRelations = relations(payRuns, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [payRuns.organizationId],
    references: [organizations.id],
  }),
  lines: many(payRunLines),
  journalEntry: one(journalEntries, {
    fields: [payRuns.journalEntryId],
    references: [journalEntries.id],
  }),
}));

export const payRunLinesRelations = relations(payRunLines, ({ one }) => ({
  organization: one(organizations, {
    fields: [payRunLines.organizationId],
    references: [organizations.id],
  }),
  payRun: one(payRuns, {
    fields: [payRunLines.payRunId],
    references: [payRuns.id],
  }),
  employee: one(employees, {
    fields: [payRunLines.employeeId],
    references: [employees.id],
  }),
  taxRuleSet: one(payrollTaxRuleSets, {
    fields: [payRunLines.taxRuleSetId],
    references: [payrollTaxRuleSets.id],
  }),
}));

export const payrollTaxRuleSetsRelations = relations(payrollTaxRuleSets, ({ many }) => ({
  brackets: many(payrollTaxBrackets),
}));

export const payrollTaxBracketsRelations = relations(payrollTaxBrackets, ({ one }) => ({
  ruleSet: one(payrollTaxRuleSets, {
    fields: [payrollTaxBrackets.ruleSetId],
    references: [payrollTaxRuleSets.id],
  }),
}));

// ---------------------------------------------------------------------------
// Budgeting (Phase 9 Slice 1) — master spec §36
// ---------------------------------------------------------------------------

/**
 * The three budget-version concepts master spec §36 names. `BASELINE` is the
 * original plan for a period; `REVISED_FORECAST` is a deliberate in-year
 * revision of it; `ROLLING_FORECAST` is produced by
 * `BudgetService.createRollingForecast` copying a source budget's lines
 * forward and letting the user re-edit the future ones — see that
 * function's doc comment. All three share one schema/one reporting path;
 * only this tag and (for ROLLING_FORECAST) `sourceBudgetId` distinguish them.
 */
export const budgetTypeEnum = pgEnum("budget_type", [
  "BASELINE",
  "REVISED_FORECAST",
  "ROLLING_FORECAST",
]);

/**
 * `DRAFT` is being built/edited and never appears in Budget vs. Actual;
 * `ACTIVE` is the one a Budget vs. Actual report or the Management Pack
 * picks up; `ARCHIVED` is retired history, kept for audit but no longer
 * live. A budget can move DRAFT→ACTIVE→ARCHIVED, or DRAFT→ARCHIVED directly
 * (discarding a draft) — `BudgetService` doesn't otherwise restrict the
 * transition order.
 */
export const budgetStatusEnum = pgEnum("budget_status", ["DRAFT", "ACTIVE", "ARCHIVED"]);

/**
 * One named budget/forecast, org-scoped, covering a fixed date range
 * (`periodStart`–`periodEnd`, inclusive — a fiscal year or any custom
 * range). This is planning data only: a budget never touches the ledger —
 * no table here has a `journalEntryId`, and `BudgetService` never calls
 * `PostingService`.
 *
 * **Only-one-active-baseline is enforced structurally, but only for
 * `BASELINE`**: `BudgetService.activate` refuses to activate a BASELINE
 * budget whose period overlaps another already-ACTIVE BASELINE budget in
 * the same org — two baselines for the same months would make "the"
 * Budget vs. Actual comparison ambiguous, the one case worth a hard
 * database-backed rule rather than just UI guidance. `REVISED_FORECAST`/
 * `ROLLING_FORECAST` budgets are deliberately NOT included in that check —
 * master spec §36 expects a revised forecast and a rolling forecast to
 * coexist alongside the baseline they were derived from (both still
 * reportable against individually), so restricting those too would block
 * the exact workflow this slice builds. See docs/roadmap.md for this
 * decision written out in full.
 */
export const budgets = pgTable("budgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: budgetTypeEnum("type").notNull().default("BASELINE"),
  status: budgetStatusEnum("status").notNull().default("DRAFT"),
  periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
  /** Set only for a REVISED_FORECAST/ROLLING_FORECAST created from another budget — traceability only, never re-read to post or recompute anything. Null for a standalone BASELINE. */
  sourceBudgetId: uuid("source_budget_id").references((): AnyPgColumn => budgets.id),
  /** The "carry forward periods after date Y" cutoff used by `createRollingForecast`, recorded for traceability. Null for anything not created that way. */
  carryForwardAfterDate: timestamp("carry_forward_after_date", { withTimezone: true, mode: "date" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgStatusTypeIdx: index("budgets_org_status_type_idx").on(table.organizationId, table.status, table.type),
  orgPeriodIdx: index("budgets_org_period_idx").on(table.organizationId, table.periodStart, table.periodEnd),
}));

/**
 * One monthly line item: `{account, optional dimension value, periodStart,
 * periodEnd, amount}` per master spec §36's "by GL account, department,
 * location, project, entity, month" — one row per account/dimension-value/
 * calendar month, the simplest granularity to report against with
 * `sumPostedActivityByAccount`'s own month-or-coarser period ranges.
 * `amount` is normal-balance-signed, the same convention
 * `normalSignedBalance` produces for actual activity (e.g. positive for a
 * REVENUE account means budgeted revenue, positive for an EXPENSE account
 * means budgeted expense) — so a budget line and the actual figure it's
 * compared against are always directly comparable with no sign-flipping in
 * the reporting layer.
 *
 * **No DB-level uniqueness constraint** on (budget, account, dimension
 * value, month): `dimensionValueId` is nullable, and Postgres treats every
 * NULL as distinct in a unique index, so a naive unique index would not
 * actually prevent two rows for "this account, no dimension, this month."
 * `BudgetService.setAccountLines` enforces "one row per account/dimension/
 * month" itself — on every bulk-entry save it deletes the existing rows for
 * that exact (budgetId, accountId, dimensionValueId) combination across the
 * whole affected period and re-inserts the new set in the same transaction,
 * so there is structurally never a duplicate even without a DB constraint.
 * See docs/database.md for this slice's write-up of the choice.
 */
export const budgetLines = pgTable("budget_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  budgetId: uuid("budget_id")
    .notNull()
    .references(() => budgets.id, { onDelete: "cascade" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  /** Optional single dimension-value scope for this line (e.g. "Department: Sales") — master spec §36's dimension axes, reusing Phase 5 Slice 2's dimension system rather than a parallel tagging mechanism. Null means "whole-organization, no dimension scope." */
  dimensionValueId: uuid("dimension_value_id").references(() => dimensionValues.id),
  periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
  /** Decimal string, normal-balance-signed — see this table's doc comment. */
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgBudgetIdx: index("budget_lines_org_budget_idx").on(table.organizationId, table.budgetId),
  budgetAccountPeriodIdx: index("budget_lines_budget_account_period_idx").on(
    table.budgetId,
    table.accountId,
    table.periodStart,
  ),
}));

export const budgetsRelations = relations(budgets, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [budgets.organizationId],
    references: [organizations.id],
  }),
  sourceBudget: one(budgets, {
    fields: [budgets.sourceBudgetId],
    references: [budgets.id],
  }),
  lines: many(budgetLines),
}));

export const budgetLinesRelations = relations(budgetLines, ({ one }) => ({
  organization: one(organizations, {
    fields: [budgetLines.organizationId],
    references: [organizations.id],
  }),
  budget: one(budgets, {
    fields: [budgetLines.budgetId],
    references: [budgets.id],
  }),
  account: one(accounts, {
    fields: [budgetLines.accountId],
    references: [accounts.id],
  }),
  dimensionValue: one(dimensionValues, {
    fields: [budgetLines.dimensionValueId],
    references: [dimensionValues.id],
  }),
}));

// ---------------------------------------------------------------------------
// Phase 9 Slice 2 — Cash Flow Intelligence & Scenario Modelling (master spec §37/§38)
// ---------------------------------------------------------------------------

/**
 * The closed set of what-if scenario types master spec §37 names. A
 * Postgres enum (not free text) for the same reason every other closed set
 * in this schema is one: a new scenario type is a deliberate code change
 * (a new zod parameter schema + a new calculation), never something a row
 * can introduce by itself.
 */
export const scenarioTypeEnum = pgEnum("scenario_type", ["HIRE_EMPLOYEE", "PRICE_CHANGE", "LOSE_CUSTOMER"]);

/**
 * A saved what-if scenario — a saved QUERY, never a stored result, exactly
 * like `saved_reports` (Phase 5): `parameters` holds only the user's typed
 * inputs and explicit assumptions (validated by the per-type zod schema in
 * `src/domain/forecasting/scenario-parameters.ts` on every write AND every
 * read), and `ScenarioService.run` recomputes Best/Expected/Worst against
 * fresh ledger data each time it's opened. Nothing about a scenario ever
 * touches the ledger: no `PostingService` call exists anywhere in the
 * forecasting domain, and this table has no journal-entry reference.
 */
export const scenarios = pgTable("scenarios", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: scenarioTypeEnum("type").notNull(),
  /** The per-type typed parameter set — see `scenario-parameters.ts`. Never holds computed results. */
  parameters: jsonb("parameters").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: uuid("created_by_id"),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgTypeIdx: index("scenarios_org_type_idx").on(table.organizationId, table.type),
}));

/**
 * One row per organization at most: the user-configurable low-cash
 * threshold the cash forecast warns against (master spec §6's "Cash
 * Warning"). Absent row means the documented default of zero — see
 * `ForecastSettingsService`. Its own tiny table rather than a column on
 * `organizations` so forecasting stays an additive domain that never
 * widens the core org row every other query reads.
 */
export const cashForecastSettings = pgTable("cash_forecast_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Decimal string, base currency. The forecast warns when a projected balance goes BELOW this. */
  lowCashThreshold: numeric("low_cash_threshold", { precision: 19, scale: 4 }).notNull().default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedById: uuid("updated_by_id"),
}, (table) => ({
  orgUnique: uniqueIndex("cash_forecast_settings_org_unique").on(table.organizationId),
}));

export const scenariosRelations = relations(scenarios, ({ one }) => ({
  organization: one(organizations, {
    fields: [scenarios.organizationId],
    references: [organizations.id],
  }),
}));

/**
 * Month-end close cycle (Phase 9 Slice 3, master spec §40). One row per
 * (period, cycle): the first close attempt is cycle 1; every REOPEN starts a
 * fresh cycle (IN_PROGRESS), so the CLOSED row of an earlier cycle is never
 * mutated again — it is the durable record of that close, including the
 * checklist snapshot taken at the moment of closing. Manual sign-offs belong
 * to a cycle (`close_signoffs`), so a reopened period must be re-reviewed.
 * Automatic checks are NEVER stored here — they are recomputed live on every
 * view (see `CloseChecklistService`).
 */
export const periodCloses = pgTable("period_closes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  fiscalPeriodId: uuid("fiscal_period_id")
    .notNull()
    .references(() => fiscalPeriods.id, { onDelete: "cascade" }),
  cycle: integer("cycle").notNull().default(1),
  status: periodCloseStatusEnum("status").notNull().default("IN_PROGRESS"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  startedById: uuid("started_by_id"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedById: uuid("closed_by_id"),
  /** The lock level the close applied (null until CLOSED). */
  lockLevelApplied: fiscalPeriodStatusEnum("lock_level_applied"),
  /** How many ATTENTION items the closer explicitly acknowledged. */
  acknowledgedAttentionCount: integer("acknowledged_attention_count").notNull().default(0),
  /** The full checklist result at the moment of closing. */
  checklistSnapshot: jsonb("checklist_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  periodCycleUnique: uniqueIndex("period_closes_period_cycle_unique").on(table.fiscalPeriodId, table.cycle),
  orgPeriodIdx: index("period_closes_org_period_idx").on(table.organizationId, table.fiscalPeriodId),
}));

/**
 * A human's explicit sign-off on a MANUAL checklist item (accruals,
 * prepayments, tax review, ...) for one close cycle — identity and
 * timestamp recorded, never presented as system verification. One per
 * (cycle, check); revoking deletes the row and is audited in `audit_logs`.
 */
export const closeSignoffs = pgTable("close_signoffs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  periodCloseId: uuid("period_close_id")
    .notNull()
    .references(() => periodCloses.id, { onDelete: "cascade" }),
  checkKey: text("check_key").notNull(),
  signedById: uuid("signed_by_id").notNull(),
  signedByName: text("signed_by_name"),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  note: text("note"),
}, (table) => ({
  cycleCheckUnique: uniqueIndex("close_signoffs_cycle_check_unique").on(table.periodCloseId, table.checkKey),
}));

/**
 * APPEND-ONLY history of every lock change on a period (who, when, why,
 * before/after level) and of every posting override. `mm_app` is granted
 * INSERT and SELECT only — no UPDATE/DELETE/TRUNCATE — the same
 * database-level guarantee as `platform_admin_audit_logs`
 * (drizzle/0037_close_slice3_row_level_security.sql, verified by a test that
 * connects as the real restricted role).
 */
export const periodLockEvents = pgTable("period_lock_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  fiscalPeriodId: uuid("fiscal_period_id")
    .notNull()
    .references(() => fiscalPeriods.id, { onDelete: "cascade" }),
  periodCloseId: uuid("period_close_id").references(() => periodCloses.id, { onDelete: "set null" }),
  eventType: periodLockEventTypeEnum("event_type").notNull(),
  fromLevel: fiscalPeriodStatusEnum("from_level").notNull(),
  toLevel: fiscalPeriodStatusEnum("to_level").notNull(),
  reason: text("reason").notNull(),
  /** Free text the actor typed to acknowledge a consequence (e.g. TAX_LOCKED: "may invalidate a lodgement"). */
  acknowledgement: text("acknowledgement"),
  actorUserId: uuid("actor_user_id"),
  actorRole: text("actor_role"),
  journalEntryId: uuid("journal_entry_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgPeriodIdx: index("period_lock_events_org_period_idx").on(table.organizationId, table.fiscalPeriodId, table.createdAt),
}));


// ---------------------------------------------------------------------------
// Public developer API (Phase 10 Slice 1) - docs/security.md section 15
// ---------------------------------------------------------------------------

/**
 * An API key for a server-to-server integration: the MANAGEMENT record (name, scopes, who made it, whether it is
 * revoked). A normal tenant table: RLS-protected on `organization_id`, written only inside `withTenant`. It never
 * holds the secret or its hash - those live only in `api_key_index`, the narrow non-tenant lookup the
 * authentication path needs BEFORE the organization is known. The key's power is never stored here: it is computed
 * on every request as `scopes` intersected with the creator's CURRENT role permissions.
 */
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Non-secret display/lookup prefix, e.g. "k3x9p2ab" (the key reads `mm_live_<prefix>_<secret>`). */
  prefix: text("prefix").notNull(),
  scopes: text("scopes").array().notNull(),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
  /** Requests per minute override; NULL = the platform default. Bounded by the service, see src/domain/api/rate-limit.ts. */
  rateLimitPerMinute: integer("rate_limit_per_minute"),
}, (table) => ({
  orgCreatedIdx: index("api_keys_org_created_idx").on(table.organizationId, table.createdAt),
  idOrgUnique: uniqueIndex("api_keys_id_org_unique").on(table.id, table.organizationId),
}));

/**
 * The authentication LOOKUP index: prefix -> (organization, key id, secret hash, creator, validity). NOT a tenant
 * table (no RLS) because the request's organization is exactly what it discovers - see docs/security.md section 15
 * for why this does not weaken tenant isolation: it holds no financial data, only SHA-256 hashes of 256-bit random
 * secrets; mm_app can read/insert it but never delete, and may only UPDATE `revoked_at` / `last_used_at`; and the
 * composite foreign key (id, organization_id) -> api_keys makes an index row for another organization's key
 * impossible to forge from inside a tenant transaction (the matching api_keys row is RLS-protected). It is
 * listed in RLS_EXEMPT_TABLES (src/db/isolation-audit.ts) next to organization_memberships.
 */
export const apiKeyIndex = pgTable("api_key_index", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  prefix: text("prefix").notNull(),
  /** Hex SHA-256 of the full key string. A 256-bit random token needs no slow hash (docs/security.md section 15). */
  secretHash: text("secret_hash").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull(),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  rateLimitPerMinute: integer("rate_limit_per_minute"),
  /** Throttled to at most one write a minute per key (it is updated inside the rate-limit statement). */
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  prefixUnique: uniqueIndex("api_key_index_prefix_unique").on(table.prefix),
  keyFk: foreignKey({
    columns: [table.id, table.organizationId],
    foreignColumns: [apiKeys.id, apiKeys.organizationId],
    name: "api_key_index_key_org_fk",
  }).onDelete("cascade"),
}));

/**
 * One fixed-window request counter per key (one row per key, so the table never grows past the number of keys and
 * needs no cleanup). Updated by a single atomic upsert per request. Has no organization column on purpose: it is
 * keyed by the key id alone and holds only counters.
 */
export const apiRateWindows = pgTable("api_rate_windows", {
  keyId: uuid("key_id")
    .primaryKey()
    .references(() => apiKeyIndex.id, { onDelete: "cascade" }),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  requestCount: integer("request_count").notNull(),
});

/**
 * Idempotency records for API POSTs. Tenant table (RLS). The row is inserted FIRST inside the same transaction as
 * the work it protects, so the unique (organization, key, idempotency key) index makes two simultaneous identical
 * requests serialise (the second waits for the first to commit, then replays its stored response) - and a failed
 * request rolls the row back with the work, so nothing is ever half-recorded. Retained 24 hours.
 */
export const apiIdempotencyKeys = pgTable("api_idempotency_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /**
   * The CREDENTIAL the key is scoped to: an API key id, or (Phase 10 Slice 4) an OAuth grant id. Deliberately NOT a
   * foreign key any more (migration 0050) - a grant lives in a different table - so the scoping is by value: two
   * credentials never share an idempotency namespace because their ids are distinct random UUIDs.
   */
  apiKeyId: uuid("api_key_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  /** SHA-256 of the canonical (method, path, body) - a reuse with a different body is refused. */
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  keyUnique: uniqueIndex("api_idempotency_org_key_unique").on(table.organizationId, table.apiKeyId, table.idempotencyKey),
  createdIdx: index("api_idempotency_created_idx").on(table.organizationId, table.createdAt),
}));

// ---- Phase 10 Slice 2: webhooks and the durable event outbox (docs/architecture.md section 11, docs/security.md section 16) ----

export const webhookSubscriptionStatusEnum = pgEnum("webhook_subscription_status", ["ACTIVE", "PAUSED", "DISABLED"]);
export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", ["PENDING", "DELIVERED", "FAILED"]);

/**
 * The TRANSACTIONAL OUTBOX. A row is inserted in the SAME transaction as the business change it describes, so an event
 * exists if and only if the change committed. `payload` is the public API's DTO snapshot of the aggregate at that moment
 * (never a raw row). `dispatched_at` is NULL until the dispatcher has fanned the event out into per-subscription
 * deliveries - that is where subscription matching happens, never at emit time. Test pings (`type = 'ping'`) are stored
 * pre-marked dispatched so fan-out never touches them.
 */
export const domainEvents = pgTable("domain_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  payload: jsonb("payload").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  /**
   * Phase 10 Slice 3. `user` for every event a business change emits; `automation` for the `automation.triggered`
   * events the Automation Centre emits. An `automation` event NEVER triggers an event rule (loop protection) - it is
   * only ever delivered to webhook subscriptions.
   */
  origin: text("origin").notNull().default("user"),
  /** When the automation evaluator has looked at this event (independent of webhook fan-out, which sets `dispatched_at`). */
  automationProcessedAt: timestamp("automation_processed_at", { withTimezone: true }),
}, (table) => ({
  orgOccurredIdx: index("domain_events_org_occurred_idx").on(table.organizationId, table.occurredAt),
  undispatchedIdx: index("domain_events_undispatched_idx").on(table.organizationId, table.occurredAt).where(sql`dispatched_at IS NULL`),
  automationPendingIdx: index("domain_events_automation_pending_idx").on(table.organizationId, table.occurredAt).where(sql`automation_processed_at IS NULL`),
}));

/**
 * A customer endpoint that wants events. The signing secret is stored ENCRYPTED (AES-256-GCM, key from
 * WEBHOOK_SECRET_ENCRYPTION_KEY, key version recorded) because signing needs the raw value; it is never returned after
 * creation and never written to the audit log. `previous_*` hold the prior secret during a rotation grace window.
 */
export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  description: text("description"),
  eventTypes: text("event_types").array().notNull(),
  status: webhookSubscriptionStatusEnum("status").notNull().default("ACTIVE"),
  /** Why a subscription is DISABLED (circuit breaker) or PAUSED, shown in the UI. */
  statusReason: text("status_reason"),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  secretCiphertext: text("secret_ciphertext").notNull(),
  secretKeyVersion: integer("secret_key_version").notNull(),
  previousSecretCiphertext: text("previous_secret_ciphertext"),
  previousSecretKeyVersion: integer("previous_secret_key_version"),
  previousSecretExpiresAt: timestamp("previous_secret_expires_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgCreatedIdx: index("webhook_subscriptions_org_created_idx").on(table.organizationId, table.createdAt),
  idOrgUnique: uniqueIndex("webhook_subscriptions_id_org_unique").on(table.id, table.organizationId),
}));

/** One row per (event, subscription): the unique pair makes fan-out idempotent. State machine PENDING -> DELIVERED | FAILED (dead letter). */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  eventId: uuid("event_id")
    .notNull()
    .references(() => domainEvents.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id")
    .notNull()
    .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
  status: webhookDeliveryStatusEnum("status").notNull().default("PENDING"),
  /** Every attempt of any kind (numbering of the log). */
  attemptCount: integer("attempt_count").notNull().default(0),
  /** Automatic attempts only: the retry policy's counter (a manual replay never consumes the schedule). */
  autoAttempts: integer("auto_attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  /** A claimed delivery is invisible to other dispatchers until this passes (crash safety: it simply becomes due again). */
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastStatusCode: integer("last_status_code"),
  lastError: text("last_error"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  eventSubUnique: uniqueIndex("webhook_deliveries_event_sub_unique").on(table.eventId, table.subscriptionId),
  dueIdx: index("webhook_deliveries_due_idx").on(table.organizationId, table.status, table.nextAttemptAt),
  subCreatedIdx: index("webhook_deliveries_sub_created_idx").on(table.subscriptionId, table.createdAt),
}));

/** APPEND-ONLY attempt log: mm_app has INSERT and SELECT only (no UPDATE, no DELETE). */
export const webhookDeliveryAttempts = pgTable("webhook_delivery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  deliveryId: uuid("delivery_id")
    .notNull()
    .references(() => webhookDeliveries.id, { onDelete: "cascade" }),
  attemptNumber: integer("attempt_number").notNull(),
  /** AUTO (dispatch), REPLAY (a person replayed it), TEST (the ping). */
  trigger: text("trigger").notNull(),
  triggeredByUserId: uuid("triggered_by_user_id").references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  statusCode: integer("status_code"),
  /** NULL on an HTTP response; otherwise a short class such as ssrf_blocked, timeout, redirect, tls, dns, connect, response_too_large. */
  errorClass: text("error_class"),
  responseExcerpt: text("response_excerpt"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  deliveryIdx: index("webhook_delivery_attempts_delivery_idx").on(table.deliveryId, table.attemptNumber),
}));

// ---------------------------------------------------------------------------
// Organisation invite codes (docs/security.md section 17)
// ---------------------------------------------------------------------------

/**
 * A pending/used/revoked invite to join an organization, redeemed with a secret CODE shared out of band (there is no
 * email delivery and no email verification, so an invite tied only to an email address would be unsafe). Tenant table
 * (RLS). The code itself is never stored here: only a non-secret display prefix. The SHA-256 of the code lives in
 * `organization_invite_index`, the narrow non-tenant lookup that lets a redeemer who is not yet a member find the
 * invite. Rows are never deleted; a state change is revoked_at (revoke) or used_at (redeem).
 */
export const organizationInvites = pgTable("organization_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Normalised (lower-cased, trimmed) address the redeeming account must have registered with. */
  email: text("email").notNull(),
  role: membershipRoleEnum("role").notNull(),
  /** Non-secret first characters of the code, so a person can tell invites apart in the list. */
  codePrefix: text("code_prefix").notNull(),
  invitedByUserId: uuid("invited_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedByUserId: uuid("used_by_user_id").references(() => users.id),
}, (table) => ({
  orgCreatedIdx: index("organization_invites_org_created_idx").on(table.organizationId, table.createdAt),
  // Target of the composite foreign key from organization_invite_index.
  idOrgUnique: uniqueIndex("organization_invites_id_org_unique").on(table.id, table.organizationId),
}));

/**
 * The narrow, NON-tenant lookup for invite redemption: code hash -> (invite id, organization id). Redemption happens
 * BEFORE the redeemer is a member, so the organization is unknown until the code resolves; the same shape of problem
 * (and the same answer) as `api_key_index`. Holds nothing beyond what is needed to open the organization's tenant
 * transaction: no email, no role, no expiry, no state (all of that is read from the RLS-protected organization_invites
 * row once the tenant context is set). SELECT + INSERT only for mm_app - no UPDATE, no DELETE, so a hash can never be
 * rewritten or re-pointed - and the composite foreign key to organization_invites(id, organization_id) means a row
 * for an invite that does not exist in that organization cannot be forged from a tenant transaction. Listed in
 * RLS_EXEMPT_TABLES (src/db/isolation-audit.ts).
 */
export const organizationInviteIndex = pgTable("organization_invite_index", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  /** Hex SHA-256 of the full invite code. A >=160-bit random code needs no slow hash. */
  codeHash: text("code_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  codeHashUnique: uniqueIndex("organization_invite_index_code_hash_unique").on(table.codeHash),
  inviteFk: foreignKey({
    columns: [table.id, table.organizationId],
    foreignColumns: [organizationInvites.id, organizationInvites.organizationId],
    name: "organization_invite_index_invite_org_fk",
  }).onDelete("cascade"),
}));

// ---------------------------------------------------------------------------
// Phase 10 Slice 3: the Automation Centre, notifications and the integration framework
// (docs/security.md sections 18-19, docs/architecture.md section 13)
// ---------------------------------------------------------------------------

export const automationJobStateEnum = pgEnum("automation_job_state", ["CLAIMED", "DONE", "RETRY", "FAILED", "SKIPPED"]);
export const automationRunOutcomeEnum = pgEnum("automation_run_outcome", ["SUCCESS", "SKIPPED", "FAILED"]);
export const notificationSeverityEnum = pgEnum("notification_severity", ["INFO", "ACTION", "WARNING", "CRITICAL"]);
export const integrationStatusEnum = pgEnum("integration_status", ["CONNECTED", "ERROR", "DISCONNECTED"]);

/**
 * One optional row per organization holding the EMERGENCY switch ("Pause all automations"). It is read on every
 * evaluation pass with no caching, so flipping it takes effect on the very next pass. Absent row = not paused.
 */
export const automationSettings = pgTable("automation_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  allPaused: boolean("all_paused").notNull().default(false),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  pausedByUserId: uuid("paused_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An automation rule: { trigger, conditions[], action } from CLOSED vocabularies (src/domain/automation/vocabulary.ts),
 * stored as JSON and RE-VALIDATED on every run. `authorised_by_user_id` is the human whose CURRENT role bounds what the
 * rule may do (initially its creator; changes when another human re-enables it, which is a fresh explicit approval).
 */
export const automationRules = pgTable("automation_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  trigger: text("trigger").notNull(),
  triggerParams: jsonb("trigger_params").notNull().default(sql`'{}'::jsonb`),
  conditions: jsonb("conditions").notNull().default(sql`'[]'::jsonb`),
  action: jsonb("action").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  /** USER_PAUSED | AUTHORISER_INACTIVE | AUTO_FAILURES | INVALID_RULE - why a rule is not enabled (null while enabled). */
  disabledCode: text("disabled_code"),
  disabledReason: text("disabled_reason"),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  authorisedByUserId: uuid("authorised_by_user_id")
    .notNull()
    .references(() => users.id),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgCreatedIdx: index("automation_rules_org_created_idx").on(table.organizationId, table.createdAt),
  idOrgUnique: uniqueIndex("automation_rules_id_org_unique").on(table.id, table.organizationId),
}));

/**
 * The idempotency / dedupe ledger and retry queue of the engine: one row per (rule, job key). The UNIQUE pair is what
 * makes "each rule fires at most once per trigger key" a database fact, not a convention. Keys: the event id, or
 * `invoice:<id>:overdue:<n>`, `bill:<id>:due_soon:<n>`, `reorder:<productId>` (the reorder row is DELETED when the product
 * recovers above its reorder point, which is what re-arms it). `context` holds only public-API-visible data.
 */
export const automationJobs = pgTable("automation_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  ruleId: uuid("rule_id")
    .notNull()
    .references(() => automationRules.id, { onDelete: "cascade" }),
  jobKey: text("job_key").notNull(),
  state: automationJobStateEnum("state").notNull().default("CLAIMED"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  context: jsonb("context").notNull(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ruleKeyUnique: uniqueIndex("automation_jobs_rule_key_unique").on(table.ruleId, table.jobKey),
  orgStateIdx: index("automation_jobs_org_state_idx").on(table.organizationId, table.state, table.nextAttemptAt),
  orgCreatedIdx: index("automation_jobs_org_created_idx").on(table.organizationId, table.createdAt),
}));

/** APPEND-ONLY run log: mm_app has INSERT and SELECT only. `rule_name` is a snapshot so the log survives a rule's deletion. */
export const automationRuns = pgTable("automation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  ruleId: uuid("rule_id").references(() => automationRules.id, { onDelete: "set null" }),
  ruleName: text("rule_name").notNull(),
  trigger: text("trigger").notNull(),
  jobKey: text("job_key").notNull(),
  attempt: integer("attempt").notNull().default(1),
  outcome: automationRunOutcomeEnum("outcome").notNull(),
  reason: text("reason"),
  /** AUTOMATION (the engine acted as the automation identity) - kept as text so the log reads on its own. */
  actorType: text("actor_type").notNull().default("AUTOMATION"),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  source: text("source").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  createdObjectType: text("created_object_type"),
  createdObjectId: uuid("created_object_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgCreatedIdx: index("automation_runs_org_created_idx").on(table.organizationId, table.createdAt),
  ruleIdx: index("automation_runs_rule_idx").on(table.ruleId, table.createdAt),
  createdObjectIdx: index("automation_runs_created_object_idx").on(table.organizationId, table.createdObjectId),
}));

/**
 * In-app notifications (master spec section 66, minimal slice). One row per recipient, resolved at creation time from
 * roles/users. Visible only to `recipient_user_id` (service rule; RLS keys on the organization like every tenant table).
 * Identical unread items are folded (`occurrences`) instead of piling up.
 */
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  recipientUserId: uuid("recipient_user_id")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  body: text("body"),
  /** An in-app path (`/<orgSlug>/...`), never an external URL. */
  link: text("link"),
  severity: notificationSeverityEnum("severity").notNull().default("INFO"),
  /** `automation` or `system`. */
  source: text("source").notNull(),
  sourceRefId: uuid("source_ref_id"),
  groupKey: text("group_key").notNull(),
  occurrences: integer("occurrences").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastOccurredAt: timestamp("last_occurred_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
}, (table) => ({
  recipientIdx: index("notifications_recipient_idx").on(table.organizationId, table.recipientUserId, table.createdAt),
  groupIdx: index("notifications_group_idx").on(table.recipientUserId, table.groupKey),
}));

/**
 * A configured integration (docs/security.md section 19). Non-secret settings live in `config`; secrets (for the Slack
 * provider: the incoming-webhook URL) are encrypted with AES-256-GCM under the SAME environment key as webhook signing
 * secrets, with additional authenticated data bound to (organization, connection). The ciphertext is never returned,
 * logged or audited. `secret_ciphertext` is NULL once disconnected.
 */
export const integrationConnections = pgTable("integration_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  name: text("name").notNull(),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  secretCiphertext: text("secret_ciphertext"),
  secretKeyVersion: integer("secret_key_version"),
  status: integrationStatusEnum("status").notNull().default("CONNECTED"),
  statusReason: text("status_reason"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgCreatedIdx: index("integration_connections_org_created_idx").on(table.organizationId, table.createdAt),
  idOrgUnique: uniqueIndex("integration_connections_id_org_unique").on(table.id, table.organizationId),
}));

/** APPEND-ONLY integration / sync log: mm_app has INSERT and SELECT only. Never contains a secret. */
export const integrationEvents = pgTable("integration_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => integrationConnections.id, { onDelete: "cascade" }),
  /** CONNECT | TEST | SEND | DISCONNECT | ERROR. */
  kind: text("kind").notNull(),
  ok: boolean("ok").notNull(),
  detail: text("detail"),
  errorClass: text("error_class"),
  statusCode: integer("status_code"),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  ruleId: uuid("rule_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  connectionIdx: index("integration_events_connection_idx").on(table.connectionId, table.createdAt),
}));

// ---------------------------------------------------------------------------
// Phase 10 Slice 4: OAuth 2.0 for third-party apps (authorization code + PKCE) - docs/security.md section 20
// ---------------------------------------------------------------------------

export const oauthClientTypeEnum = pgEnum("oauth_client_type", ["PUBLIC", "CONFIDENTIAL"]);

/**
 * A registered third-party application. A normal TENANT table (RLS on organization_id): an app belongs to the
 * organisation whose Owner/Administrator registered it and can only ever be authorised into THAT organisation
 * (docs/security.md section 20 explains why). Holds the SHA-256 hash of a confidential client's secret (never the
 * secret); public clients have neither. Soft-deleted (`deleted_at`) so the audit trail and the grant history keep
 * their referent; disabling or deleting an app revokes every grant in the same transaction.
 */
export const oauthApps = pgTable("oauth_apps", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Public identifier `mmo_c_<random>`. Unique platform-wide (see oauth_client_index). */
  clientId: text("client_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  homepageUrl: text("homepage_url"),
  clientType: oauthClientTypeEnum("client_type").notNull(),
  /** Exact-match redirect URIs (https, or http loopback with any port). */
  redirectUris: text("redirect_uris").array().notNull(),
  /** The ceiling of scopes this app may ever request (same vocabulary as API keys). */
  scopes: text("scopes").array().notNull(),
  /** Non-secret display tag of the current client secret (confidential only). */
  secretPrefix: text("secret_prefix"),
  /** Hex SHA-256 of the full client secret (confidential only). */
  secretHash: text("secret_hash"),
  secretRotatedAt: timestamp("secret_rotated_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  disabledByUserId: uuid("disabled_by_user_id").references(() => users.id),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
}, (table) => ({
  orgCreatedIdx: index("oauth_apps_org_created_idx").on(table.organizationId, table.createdAt),
  clientIdUnique: uniqueIndex("oauth_apps_client_id_unique").on(table.clientId),
  idOrgUnique: uniqueIndex("oauth_apps_id_org_unique").on(table.id, table.organizationId),
}));

/**
 * The narrow NON-tenant lookup `client_id -> (app id, organisation id, client type)`. The authorize and token
 * endpoints receive only a client_id, before any organisation is known - the same shape of problem (and answer) as
 * `api_key_index`. IMMUTABLE for mm_app (SELECT + INSERT only): everything that can change (redirect URIs, scopes,
 * secret hash, disabled/deleted) is read from the RLS-protected `oauth_apps` row once the tenant context is open.
 * The composite foreign key to oauth_apps(id, organization_id) makes a row for an app that does not exist in that
 * organisation impossible to forge from a tenant transaction. Listed in RLS_EXEMPT_TABLES.
 */
export const oauthClientIndex = pgTable("oauth_client_index", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  clientId: text("client_id").notNull(),
  clientType: oauthClientTypeEnum("client_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  clientIdUnique: uniqueIndex("oauth_client_index_client_id_unique").on(table.clientId),
  appFk: foreignKey({
    columns: [table.id, table.organizationId],
    foreignColumns: [oauthApps.id, oauthApps.organizationId],
    name: "oauth_client_index_app_org_fk",
  }).onDelete("cascade"),
}));

/**
 * One consent = one grant, created when the authorization code is EXCHANGED (so every row here is a real grant that
 * minted tokens). A tenant table. Revocation (by the user, an Owner/Administrator, an app disable/delete, a code
 * replay or a refresh-token reuse) sets `revoked_at` and the reason; nothing is deleted. The grant carries the scopes
 * the user consented to; its POWER is never stored - it is recomputed on every API request as scopes intersected with
 * the user's current role (src/domain/api/scopes.ts `effectivePermissions`).
 */
export const oauthGrants = pgTable("oauth_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  appId: uuid("app_id")
    .notNull()
    .references(() => oauthApps.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  scopes: text("scopes").array().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
  /** USER | ADMIN | APP_DISABLED | APP_DELETED | APP_SCOPES_REDUCED | CODE_REPLAY | REFRESH_REUSE | CLIENT. */
  revokeReason: text("revoke_reason"),
}, (table) => ({
  orgAppIdx: index("oauth_grants_org_app_idx").on(table.organizationId, table.appId),
  orgUserIdx: index("oauth_grants_org_user_idx").on(table.organizationId, table.userId),
  idOrgUnique: uniqueIndex("oauth_grants_id_org_unique").on(table.id, table.organizationId),
}));

/**
 * A single-use authorization code (<= 60 seconds), stored only as a SHA-256 hash. Bound to the client, redirect URI,
 * PKCE challenge (S256), user, organisation and scopes at consent time. Consumed by an atomic
 * `UPDATE ... WHERE used_at IS NULL RETURNING`; `grant_id` is set when it is exchanged so a REPLAY can revoke what
 * the first use created. A tenant table: the token endpoint resolves the organisation from the client id first.
 */
export const oauthAuthorizationCodes = pgTable("oauth_authorization_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  appId: uuid("app_id")
    .notNull()
    .references(() => oauthApps.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  codeHash: text("code_hash").notNull(),
  scopes: text("scopes").array().notNull(),
  redirectUri: text("redirect_uri").notNull(),
  /** base64url(SHA-256(code_verifier)). Only S256 exists; there is no `plain`. */
  codeChallenge: text("code_challenge").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  grantId: uuid("grant_id").references(() => oauthGrants.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  codeHashUnique: uniqueIndex("oauth_authorization_codes_code_hash_unique").on(table.codeHash),
  orgExpiresIdx: index("oauth_authorization_codes_org_expires_idx").on(table.organizationId, table.expiresAt),
}));

/**
 * Refresh tokens: opaque, hashed, ROTATED on every use. `used_at` is set by the atomic claim when a token is
 * exchanged; presenting a token whose `used_at` is already set is a REUSE and revokes the whole grant (RFC 9700).
 * A tenant table - the endpoint resolves the organisation from the presented client id.
 */
export const oauthRefreshTokens = pgTable("oauth_refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  grantId: uuid("grant_id")
    .notNull()
    .references(() => oauthGrants.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenHashUnique: uniqueIndex("oauth_refresh_tokens_token_hash_unique").on(table.tokenHash),
  grantIdx: index("oauth_refresh_tokens_grant_idx").on(table.grantId),
}));

/**
 * The bearer-authentication LOOKUP for OAuth access tokens: prefix -> (token, grant, app, organisation, user, scopes,
 * validity, hash). NOT a tenant table, for exactly the reason `api_key_index` is not: the API authenticates a token
 * BEFORE it knows the organisation. Bounded by GRANTs (SELECT + INSERT, UPDATE of only revoked_at, DELETE for the
 * grant-scoped purge of long-expired rows) and by the composite foreign key to the RLS-protected `oauth_grants`, so a
 * row for another organisation's grant cannot be forged from a tenant transaction. Listed in RLS_EXEMPT_TABLES.
 */
export const oauthAccessTokens = pgTable("oauth_access_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  grantId: uuid("grant_id").notNull(),
  appId: uuid("app_id").notNull(),
  /** The public client id of the app (recorded in audit metadata and `GET /me`; not a secret). */
  clientId: text("client_id").notNull(),
  userId: uuid("user_id").notNull(),
  /** Non-secret lookup/display prefix (the token reads `mmo_at_<prefix>_<secret>`). */
  prefix: text("prefix").notNull(),
  /** Hex SHA-256 of the full token. */
  secretHash: text("secret_hash").notNull(),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  prefixUnique: uniqueIndex("oauth_access_tokens_prefix_unique").on(table.prefix),
  grantIdx: index("oauth_access_tokens_grant_idx").on(table.grantId),
  appIdx: index("oauth_access_tokens_app_idx").on(table.appId),
  grantFk: foreignKey({
    columns: [table.grantId, table.organizationId],
    foreignColumns: [oauthGrants.id, oauthGrants.organizationId],
    name: "oauth_access_tokens_grant_org_fk",
  }).onDelete("cascade"),
}));

/**
 * Fixed-window request counters for OAuth: `api:<grant id>` for API requests made with an access token, and
 * `tok:ip:<address>` / `tok:client:<client id>` for the token and revocation endpoints. A text key (not a uuid FK) so
 * one table serves all three; holds only counters, no organisation column. Old rows are purged opportunistically.
 */
export const oauthRateWindows = pgTable("oauth_rate_windows", {
  bucket: text("bucket").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  requestCount: integer("request_count").notNull(),
});

// ---------------------------------------------------------------------------
// Login security (master spec 47; docs/security.md section 22)
// ---------------------------------------------------------------------------

/**
 * Failed-sign-in counters and temporary lockouts, in Postgres so every serverless instance agrees. Sign-in happens
 * BEFORE any tenant or user context exists, so this is NOT a tenant/user-scoped table (no organization_id /
 * owner_user_id column; same stance as api_key_index / oauth_rate_windows) and holds no personal data: the bucket is a
 * keyed HMAC of the normalised email (`acct:<hmac>`) or of the client address (`ip:<hmac>`), never the raw value. The
 * same counter exists for an email that has no account, so a lockout does not reveal whether an account exists.
 */
export const loginThrottles = pgTable("login_throttles", {
  bucket: text("bucket").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  /** How many lockouts in a row; the next lockout lasts base * 2^lock_level (capped). Decays after 24 h of quiet. */
  lockLevel: integer("lock_level").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  updatedIdx: index("login_throttles_updated_idx").on(table.updatedAt),
}));

/**
 * Append-only platform-level log of authentication events (sign-in success / failure / lockout, MFA, password reset,
 * email verification). Not a tenant table: sign-in precedes tenant context. mm_app has SELECT + INSERT only. Holds NO
 * secret, code, token or raw IP: `email_hash` and `ip_hash` are keyed HMACs, `ip_prefix_hash` is a keyed HMAC of the
 * /24 (IPv4) or /48 (IPv6) network used only to recognise a new location, `user_agent_family` is a coarse "Chrome on
 * Windows" label. `user_id` is a plain reference (no FK) so the row outlives the user.
 */
export const authEvents = pgTable("auth_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  event: text("event").notNull(),
  emailHash: text("email_hash"),
  ipHash: text("ip_hash"),
  ipPrefixHash: text("ip_prefix_hash"),
  userAgentFamily: text("user_agent_family"),
  newDevice: boolean("new_device").notNull().default(false),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdx: index("auth_events_user_idx").on(table.userId, table.createdAt),
  eventIdx: index("auth_events_event_idx").on(table.event, table.createdAt),
}));

// ---------------------------------------------------------------------------
// Approval engine (master spec s.45) - configurable multi-step approvals layered ON TOP of the single-step flows.
// ---------------------------------------------------------------------------

/**
 * One org-configurable routing rule for one document type. The FIRST active policy (lowest `priority`, then oldest) whose
 * amount band and filters match a document wins; no matching policy means the document's existing flow is unchanged.
 * `min_amount` is INCLUSIVE and `max_amount` EXCLUSIVE, so adjacent tiers ($0-$500, $500-$5,000, ...) never overlap.
 * `filters` = { supplierContactIds?, accountIds?, projectIds?, userIds?, currency? } (all optional; a list matches when ANY
 * of the document's values is in it). `steps` = ordered [{ name, roles[], userIds[], requiredApprovals }]. Policies are
 * deactivated, never deleted; a request snapshots its policy, so editing a policy never changes an in-flight request.
 */
export const approvalPolicies = pgTable("approval_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  documentType: text("document_type").notNull(),
  priority: integer("priority").notNull().default(100),
  isActive: boolean("is_active").notNull().default(true),
  minAmount: numeric("min_amount", { precision: 19, scale: 4 }),
  maxAmount: numeric("max_amount", { precision: 19, scale: 4 }),
  filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
  steps: jsonb("steps").notNull(),
  /** When true one person may satisfy more than one step of the same request (audited). Default: never. */
  allowSamePersonMultipleSteps: boolean("allow_same_person_multiple_steps").notNull().default(false),
  createdById: uuid("created_by_id").notNull(),
  updatedById: uuid("updated_by_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgTypeIdx: index("approval_policies_org_type_idx").on(table.organizationId, table.documentType, table.priority),
  typeCheck: check("approval_policies_type_check", sql`${table.documentType} IN ('SUPPLIER_BILL','EXPENSE_CLAIM','PAYMENT_RUN')`),
  bandCheck: check("approval_policies_band_check", sql`${table.minAmount} IS NULL OR ${table.maxAmount} IS NULL OR ${table.maxAmount} > ${table.minAmount}`),
}));

/**
 * One approval attempt for one document. A resubmission after rejection/edit creates a NEW request; old ones are kept.
 * At most one PENDING request per document (partial unique index). `policy_snapshot` freezes the matched policy's
 * band/steps at creation. `excluded_user_ids` = people who can never decide it (requester, document creator/claimant).
 */
export const approvalRequests = pgTable("approval_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  documentType: text("document_type").notNull(),
  documentId: uuid("document_id").notNull(),
  documentLabel: text("document_label").notNull(),
  documentSummary: text("document_summary"),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  currency: text("currency").notNull(),
  policyId: uuid("policy_id"),
  policyName: text("policy_name").notNull(),
  policySnapshot: jsonb("policy_snapshot").notNull(),
  status: text("status").notNull().default("PENDING"),
  requestedById: uuid("requested_by_id").notNull(),
  excludedUserIds: jsonb("excluded_user_ids").notNull().default(sql`'[]'::jsonb`),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionReason: text("decision_reason"),
  /** Set when an OWNER/ADMINISTRATOR forced the outcome past the normal steps; always with a reason. */
  overriddenById: uuid("overridden_by_id"),
  overrideReason: text("override_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgDocIdx: index("approval_requests_org_doc_idx").on(table.organizationId, table.documentType, table.documentId, table.requestedAt),
  orgStatusIdx: index("approval_requests_org_status_idx").on(table.organizationId, table.status, table.requestedAt),
  onePendingPerDoc: uniqueIndex("approval_requests_one_pending_unique")
    .on(table.organizationId, table.documentType, table.documentId)
    .where(sql`${table.status} = 'PENDING'`),
  statusCheck: check("approval_requests_status_check", sql`${table.status} IN ('PENDING','APPROVED','REJECTED','CANCELLED')`),
}));

/** The ordered steps of a request (copied from the policy so later policy edits cannot alter them). Steps open in order. */
export const approvalSteps = pgTable("approval_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  requestId: uuid("request_id")
    .notNull()
    .references(() => approvalRequests.id, { onDelete: "cascade" }),
  stepIndex: integer("step_index").notNull(),
  name: text("name").notNull(),
  requiredRoles: jsonb("required_roles").notNull().default(sql`'[]'::jsonb`),
  requiredUserIds: jsonb("required_user_ids").notNull().default(sql`'[]'::jsonb`),
  requiredApprovals: integer("required_approvals").notNull().default(1),
  status: text("status").notNull().default("PENDING"),
  /** When the step became the active one ("waiting since"). Null while it is still queued behind an earlier step. */
  openedAt: timestamp("opened_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => ({
  requestIdx: uniqueIndex("approval_steps_request_idx").on(table.requestId, table.stepIndex),
  orgStatusIdx: index("approval_steps_org_status_idx").on(table.organizationId, table.status),
  statusCheck: check("approval_steps_status_check", sql`${table.status} IN ('PENDING','APPROVED','REJECTED','CANCELLED','SKIPPED')`),
  countCheck: check("approval_steps_count_check", sql`${table.requiredApprovals} >= 1`),
}));

/** Append-only log of every person's decision on a step (approve / reject), and of administrative reassignments. */
export const approvalDecisions = pgTable("approval_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  requestId: uuid("request_id")
    .notNull()
    .references(() => approvalRequests.id, { onDelete: "cascade" }),
  stepId: uuid("step_id").references(() => approvalSteps.id, { onDelete: "cascade" }),
  decidedById: uuid("decided_by_id").notNull(),
  /** APPROVE | REJECT | OVERRIDE_APPROVE | OVERRIDE_REJECT | REASSIGN */
  decision: text("decision").notNull(),
  comment: text("comment"),
  /** The decider's role as recomputed at decision time. */
  deciderRole: text("decider_role").notNull(),
  /** True when this person had already decided another step of the same request (only allowed by an explicit policy flag). */
  repeatApprover: boolean("repeat_approver").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  requestIdx: index("approval_decisions_request_idx").on(table.requestId, table.createdAt),
  decisionCheck: check("approval_decisions_decision_check", sql`${table.decision} IN ('APPROVE','REJECT','OVERRIDE_APPROVE','OVERRIDE_REJECT','REASSIGN')`),
}));
