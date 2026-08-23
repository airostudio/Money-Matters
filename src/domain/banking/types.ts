import type { bankImportFormatEnum, bankTransactionStatusEnum } from "@/db/schema";

export type BankImportFormat = (typeof bankImportFormatEnum.enumValues)[number];
export type BankTransactionStatus = (typeof bankTransactionStatusEnum.enumValues)[number];

/**
 * A single normalized line from a parsed bank statement, before it becomes
 * a `bank_transactions` row. Every parser (CSV/OFX/QIF) produces this same
 * shape — the rest of the import pipeline (`bank-import-service.ts`) never
 * needs to know which format a row came from.
 */
export interface ParsedStatementRow {
  /** The bank/format's own transaction id, when one exists (OFX FITID). Undefined for CSV/QIF. */
  externalId?: string;
  postedDate: Date;
  description: string;
  /** Decimal string. Positive = money in, negative = money out — see docs/database.md. */
  amount: string;
  balanceAfter?: string;
  /** The original row/fields, kept for audit and for showing "why" a match or category was chosen. */
  raw: Record<string, unknown>;
}

export interface ParsedStatement {
  rows: ParsedStatementRow[];
  /** Non-fatal issues (an unparsable row, an unrecognized column) — surfaced to the importing user, not thrown. */
  warnings: string[];
}

export type BankRuleConditionField = "description" | "amount";
export type BankRuleConditionOperator =
  | "CONTAINS"
  | "EQUALS"
  | "STARTS_WITH"
  | "AMOUNT_EQUALS"
  | "AMOUNT_BETWEEN";

export interface BankRuleCondition {
  field: BankRuleConditionField;
  operator: BankRuleConditionOperator;
  /** CONTAINS/EQUALS/STARTS_WITH: string. AMOUNT_EQUALS: decimal string. AMOUNT_BETWEEN: [min, max] decimal strings. */
  value: string | [string, string];
}

export interface BankRuleAction {
  categorizedAccountId: string;
  contactId?: string;
  taxCodeId?: string;
}

/** A candidate reconciliation match, ranked highest-confidence first — see reconciliation-service.ts. */
export interface MatchCandidate {
  journalLineId: string;
  journalEntryId: string;
  entryNumber: string;
  postingDate: Date;
  memo: string | null;
  amount: string;
  /** 0-1. Deterministic today (exact-amount/date-window rules); see docs/decisions/0006-bank-feed-abstraction.md for why this stays rule-based rather than an opaque model score. */
  confidence: number;
  /** Plain-language reason a human (or the AI explanation layer, later) can show as-is. */
  explanation: string;
}
