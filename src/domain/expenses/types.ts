import type { expenseClaimStatusEnum } from "@/db/schema";

export type ExpenseClaimStatus = (typeof expenseClaimStatusEnum.enumValues)[number];

export interface ExpenseClaimLineInput {
  description: string;
  /** Decimal string, e.g. "45.00". Must be positive. */
  amount: string;
  /** Expense account this line's amount is debited to on approval. */
  expenseAccountId: string;
  /** Optional — a zero-rated/out-of-scope line has none. */
  taxCodeId?: string;
  /** Free-text category, e.g. "Travel", "Meals" — informational, shown in the UI, not posted anywhere. */
  category?: string;
  /** Optional link to an uploaded receipt (Document AI) this line was captured/prefilled from. */
  receiptId?: string;
}

export interface CreateExpenseClaimInput {
  employeeUserId: string;
  claimDate: Date;
  description: string;
  currency: string;
  /** The liability control account ("Employee Reimbursements Payable") this claim posts to on approval. */
  payableAccountId: string;
  memo?: string;
  lines: ExpenseClaimLineInput[];
}

export type UpdateExpenseClaimInput = CreateExpenseClaimInput;

export interface MarkReimbursedInput {
  /** The bank/asset account credited (money actually leaving the business). */
  reimbursementAccountId: string;
  reimbursementDate: Date;
  reference?: string;
}
