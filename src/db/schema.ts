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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

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
]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export const auditActorTypeEnum = pgEnum("audit_actor_type", ["HUMAN", "AI", "SYSTEM"]);

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
  journalLines: many(journalLines),
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
