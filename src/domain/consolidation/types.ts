import type { AccountType } from "@/domain/accounts/account-service";

/**
 * Hard cap on entities per consolidation group. A consolidated report opens one
 * pooled database connection per entity per statement, strictly one after the
 * other (see docs/security.md section 12 and the Supabase session-pooler note
 * in src/db/client.ts) — so the cap bounds both latency and connection churn.
 * It is enforced when an entity is added AND again when a report is built.
 */
export const MAX_ENTITIES_PER_GROUP = 10;

export type GroupRole = "PARENT" | "SUBSIDIARY";

export type IntercompanyKind =
  | "RECEIVABLE"
  | "PAYABLE"
  | "LOAN_RECEIVABLE"
  | "LOAN_PAYABLE"
  | "REVENUE"
  | "EXPENSE";

/** The account type each intercompany kind must be designated on. */
export const INTERCOMPANY_KIND_ACCOUNT_TYPE: Record<IntercompanyKind, AccountType> = {
  RECEIVABLE: "ASSET",
  PAYABLE: "LIABILITY",
  LOAN_RECEIVABLE: "ASSET",
  LOAN_PAYABLE: "LIABILITY",
  REVENUE: "REVENUE",
  EXPENSE: "EXPENSE",
};

/** A group account: one line of the group's own chart of accounts, matched by (type, code). */
export interface GroupAccountDef {
  id: string;
  type: AccountType;
  code: string;
  name: string;
}

/** Explicit override: this entity account reports under that group account. */
export interface AccountMappingDef {
  organizationId: string;
  accountId: string;
  groupAccountId: string;
}

export interface IntercompanyDef {
  organizationId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  kind: IntercompanyKind;
  counterpartyOrganizationId: string;
}

export interface AdjustmentLineDef {
  groupAccountId: string;
  /** Exact decimal strings. One of the two is "0". */
  debit: string;
  credit: string;
  memo?: string | null;
}

export interface AdjustmentDef {
  id: string;
  kind: "ELIMINATION" | "ADJUSTMENT";
  effectiveDate: Date;
  description: string;
  reason: string;
  reversesAdjustmentId: string | null;
  lines: AdjustmentLineDef[];
}

/** Everything group-level that the pure engine needs — loaded once, in one user-scoped transaction. */
export interface ConsolidationConfig {
  groupAccounts: GroupAccountDef[];
  mappings: AccountMappingDef[];
  intercompany: IntercompanyDef[];
  adjustments: AdjustmentDef[];
}

/** One entity as it appears in a consolidated report. */
export interface EntityRef {
  organizationId: string;
  name: string;
  slug: string;
  currency: string;
  role: GroupRole;
}

/**
 * One already-authorised line of an entity's own statement, normal-balance
 * signed (positive = in the account's own direction), as ReportingService
 * produced it. The engine never sees anything an entity's own report did not
 * already contain.
 */
export interface EntityLine {
  /** `null` only for the two computed earnings lines of a Balance Sheet. */
  accountId: string | null;
  code: string | null;
  name: string;
  type: AccountType;
  computed?: "RE_PRIOR" | "CURRENT_YEAR";
  amount: string;
}

export interface EntityStatement {
  entity: EntityRef;
  lines: EntityLine[];
}

export type MappingSource = "EXPLICIT" | "DEFAULT" | "UNMAPPED" | "COMPUTED";

export interface LineSource {
  organizationId: string;
  organizationSlug: string;
  /** Entity account id, or null for a computed line. Drill-down links need it. */
  accountId: string | null;
  code: string | null;
  name: string;
  amount: string;
  mapping: MappingSource;
}

export interface ConsolidatedLine {
  key: string;
  kind: "GROUP_ACCOUNT" | "UNMAPPED" | "COMPUTED";
  type: AccountType;
  code: string | null;
  name: string;
  /** organizationId -> amount (only entities with a non-zero contribution are present; absent means zero). */
  byEntity: Record<string, string>;
  /** Simple sum of the entities before any elimination or adjustment. */
  combined: string;
  /** Intercompany eliminations (computed, never posted anywhere). */
  eliminations: string;
  /** Manual group-level consolidation adjustments. */
  adjustments: string;
  consolidated: string;
  sources: LineSource[];
}

/** Column totals for a section or a statement-level figure. */
export interface ColumnTotals {
  byEntity: Record<string, string>;
  combined: string;
  eliminations: string;
  adjustments: string;
  consolidated: string;
}

export interface ConsolidatedSection {
  lines: ConsolidatedLine[];
  totals: ColumnTotals;
}

export type IntercompanyCategory = "TRADE" | "LOAN" | "INCOME_EXPENSE";

export type ReconciliationStatus = "MATCHED" | "MISMATCH" | "ONE_SIDED" | "COUNTERPARTY_UNAVAILABLE";

/**
 * One reconciliation row: the creditor side's books versus the debtor side's.
 * `difference` = creditor - debtor and is NEVER forced to zero: whatever is not
 * matched stays in the consolidated figures and is listed here.
 */
export interface IntercompanyReconciliationRow {
  category: IntercompanyCategory;
  creditor: { organizationId: string; name: string; amount: string } | null;
  debtor: { organizationId: string; name: string; amount: string } | null;
  /** The amount actually eliminated (min of both sides when both are positive, else 0). */
  matched: string;
  difference: string;
  status: ReconciliationStatus;
  /** Set when a designation could not be used (e.g. the account's type changed since it was designated). */
  note?: string;
}

export interface EliminationEntryLine {
  organizationId: string;
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  side: "DEBIT" | "CREDIT";
  amount: string;
}

/** A computed elimination journal (presentation only — never posted to any ledger). */
export interface EliminationEntry {
  id: string;
  category: IntercompanyCategory;
  description: string;
  amount: string;
  lines: EliminationEntryLine[];
}

export interface AppliedAdjustment {
  id: string;
  kind: "ELIMINATION" | "ADJUSTMENT";
  effectiveDate: string;
  description: string;
  reversesAdjustmentId: string | null;
  lines: Array<{ groupAccountId: string; code: string; name: string; type: AccountType; debit: string; credit: string }>;
}

export interface EntityColumn {
  organizationId: string;
  name: string;
  slug: string;
  role: GroupRole;
}

export interface ConsolidatedProfitAndLoss {
  currency: string;
  from: string;
  to: string;
  entities: EntityColumn[];
  revenue: ConsolidatedSection;
  expenses: ConsolidatedSection;
  netProfit: ColumnTotals;
  eliminationEntries: EliminationEntry[];
  adjustments: AppliedAdjustment[];
  reconciliation: IntercompanyReconciliationRow[];
  unmapped: { count: number };
}

export interface ConsolidatedBalanceSheet {
  currency: string;
  asOfDate: string;
  entities: EntityColumn[];
  assets: ConsolidatedSection;
  liabilities: ConsolidatedSection;
  equity: ConsolidatedSection;
  totalLiabilitiesAndEquity: ColumnTotals;
  /** Assets - (Liabilities + Equity), per column. Every column should be exactly zero. */
  difference: ColumnTotals;
  /** True only when EVERY column (each entity, combined, adjustments, consolidated) balances. */
  isBalanced: boolean;
  /** The consolidated column alone. */
  isConsolidatedBalanced: boolean;
  eliminationEntries: EliminationEntry[];
  adjustments: AppliedAdjustment[];
  reconciliation: IntercompanyReconciliationRow[];
  unmapped: { count: number };
}

export interface ConsolidatedCash {
  currency: string;
  asOfDate: string;
  entities: Array<{
    organizationId: string;
    name: string;
    slug: string;
    total: string;
    accounts: Array<{ bankAccountId: string; name: string; institutionName: string | null; balance: string }>;
  }>;
  total: string;
}

export interface ExclusionNotice {
  /** Number of group entities left out because the user has no access to them. */
  count: number;
  /** "2 entities excluded — no access", or null when nothing was excluded. */
  notice: string | null;
  /**
   * Names ONLY for entities the user is still an active member of (so the name
   * is already known to them). An entity they are not a member of is never
   * named, identified or described — it only contributes to `count`.
   */
  knownNames: string[];
}

export interface ConsolidationMeta {
  group: { id: string; name: string };
  exclusions: ExclusionNotice;
  /** Members the owner switched off with the "included" flag — their own choice, not an access problem. */
  deselectedCount: number;
}

export type ConsolidatedReport<T> = T & ConsolidationMeta;
