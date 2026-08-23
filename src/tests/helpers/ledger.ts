import { AccountService, type AccountType } from "@/domain/accounts/account-service";
import type { Actor } from "@/domain/permissions/permission-service";

const SAMPLE_ACCOUNT_DEFS: Array<{ code: string; name: string; type: AccountType }> = [
  { code: "1000", name: "Business Bank Account", type: "ASSET" },
  { code: "1100", name: "Accounts Receivable", type: "ASSET" },
  { code: "2000", name: "Accounts Payable", type: "LIABILITY" },
  { code: "2100", name: "GST Payable", type: "LIABILITY" },
  { code: "4000", name: "Sales Revenue", type: "REVENUE" },
  { code: "6000", name: "General Expenses", type: "EXPENSE" },
];

/** Creates a small, varied chart of accounts for tests that just need real account ids. */
export async function createSampleAccounts(actor: Actor, currency: string): Promise<string[]> {
  const accounts = [];
  for (const def of SAMPLE_ACCOUNT_DEFS) {
    accounts.push(await AccountService.create(actor, { ...def, currency }));
  }
  return accounts.map((a) => a.id);
}
