export interface JournalLineDraft {
  accountId: string;
  /** Decimal string. Exactly one of debit/credit must be a positive amount. */
  debit?: string;
  credit?: string;
  currency: string;
  /** Decimal string, defaults to "1". Rate to convert this line into the org's base currency. */
  exchangeRate?: string;
  contactId?: string;
  taxCodeId?: string;
  memo?: string;
  dimensionValueIds?: string[];
}

export interface JournalEntryDraft {
  postingDate: Date;
  memo?: string;
  sourceType?: "MANUAL" | "OPENING_BALANCE" | "SYSTEM";
  lines: JournalLineDraft[];
}

export interface PostedJournalResult {
  entryId: string;
  entryNumber: string;
}
