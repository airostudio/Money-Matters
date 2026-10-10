import type { AccountType } from "@/domain/accounts/account-service";

/**
 * Curated, versioned chart-of-accounts templates for onboarding (master
 * spec §60, §32/§4). These are the ONLY source of account codes/names that
 * ever reach the ledger during onboarding — see docs/ai-agents.md's
 * "classify, never generate" pattern. The AI recommender (see
 * `chart-of-accounts-recommender.ts`) only ever picks a `templateKey` and a
 * small set of booleans; it never invents an account.
 *
 * Bumping `TEMPLATE_LIBRARY_VERSION` is a reminder to think about
 * backward-compat if a template's account codes/names change after
 * organizations have already onboarded with them — existing orgs are
 * unaffected either way since the wizard only ever writes accounts once,
 * through `AccountService.create`.
 */
export const TEMPLATE_LIBRARY_VERSION = 1;

export const TEMPLATE_KEYS = [
  "TRADES",
  "PROFESSIONAL_SERVICES",
  "RETAIL",
  "HOSPITALITY",
  "GENERAL",
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  TRADES: "Trades & Contracting",
  PROFESSIONAL_SERVICES: "Professional Services",
  RETAIL: "Retail & E-commerce",
  HOSPITALITY: "Hospitality & Food Service",
  GENERAL: "General / Other",
};

/** The classification flags the recommender produces — never account data itself. */
export interface ClassificationFlags {
  sellsGoods: boolean;
  sellsServices: boolean;
  hasEmployees: boolean;
  tracksInventory: boolean;
}

export const DEFAULT_FLAGS: ClassificationFlags = {
  sellsGoods: false,
  sellsServices: true,
  hasEmployees: false,
  tracksInventory: false,
};

export type AccountGroup = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export interface TemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  subType?: string;
  /** Description shown in the preview UI, explaining why the account exists. */
  description?: string;
}

interface TemplateAccountDef extends TemplateAccount {
  /** Included unless a flag predicate says otherwise. Always included when omitted. */
  includeIf?: (flags: ClassificationFlags) => boolean;
}

/**
 * A "Business Bank Account" ASSET account code every template defines, so
 * step 4 of the wizard (link a bank account) always has a sensible default
 * to pre-select once the chart of accounts exists.
 */
export const DEFAULT_BANK_ACCOUNT_CODE = "1000";

const COMMON_ASSETS: TemplateAccountDef[] = [
  { code: "1000", name: "Business Bank Account", type: "ASSET", subType: "Bank" },
  { code: "1010", name: "Business Savings Account", type: "ASSET", subType: "Bank" },
  { code: "1100", name: "Accounts Receivable", type: "ASSET", subType: "Current Asset" },
];

const INVENTORY_ASSET: TemplateAccountDef = {
  code: "1200",
  name: "Inventory",
  type: "ASSET",
  subType: "Current Asset",
  includeIf: (f) => f.tracksInventory,
};

const COMMON_LIABILITIES: TemplateAccountDef[] = [
  { code: "2000", name: "Accounts Payable", type: "LIABILITY", subType: "Current Liability" },
  { code: "2100", name: "GST Payable", type: "LIABILITY", subType: "Current Liability" },
  { code: "2400", name: "Business Credit Card", type: "LIABILITY", subType: "Current Liability" },
];

const PAYROLL_LIABILITIES: TemplateAccountDef[] = [
  {
    code: "2200",
    name: "PAYG Withholding Payable",
    type: "LIABILITY",
    subType: "Current Liability",
    includeIf: (f) => f.hasEmployees,
  },
  {
    code: "2300",
    name: "Superannuation Payable",
    type: "LIABILITY",
    subType: "Current Liability",
    includeIf: (f) => f.hasEmployees,
  },
];

const LOAN_LIABILITY: TemplateAccountDef = {
  code: "2500",
  name: "Business Loan",
  type: "LIABILITY",
  subType: "Non-current Liability",
};

const COMMON_EQUITY: TemplateAccountDef[] = [{ code: "3100", name: "Owner's Drawings", type: "EQUITY" }];

const GOODS_COGS: TemplateAccountDef[] = [
  {
    code: "5000",
    name: "Cost of Goods Sold",
    type: "EXPENSE",
    subType: "Cost of Sales",
    includeIf: (f) => f.sellsGoods,
  },
  {
    code: "5100",
    name: "Freight & Shipping (COGS)",
    type: "EXPENSE",
    subType: "Cost of Sales",
    includeIf: (f) => f.sellsGoods,
  },
];

const PAYROLL_EXPENSES: TemplateAccountDef[] = [
  {
    code: "6000",
    name: "Wages & Salaries",
    type: "EXPENSE",
    includeIf: (f) => f.hasEmployees,
  },
  {
    code: "6050",
    name: "Superannuation Expense",
    type: "EXPENSE",
    includeIf: (f) => f.hasEmployees,
  },
];

const COMMON_OPERATING_EXPENSES: TemplateAccountDef[] = [
  { code: "6400", name: "Rent", type: "EXPENSE" },
  { code: "6500", name: "Insurance", type: "EXPENSE" },
  { code: "6600", name: "Telephone & Internet", type: "EXPENSE" },
  { code: "6700", name: "Bank Fees", type: "EXPENSE" },
  { code: "6750", name: "Accounting & Bookkeeping Fees", type: "EXPENSE" },
  { code: "6800", name: "Depreciation Expense", type: "EXPENSE" },
  { code: "6900", name: "Office Supplies", type: "EXPENSE" },
];

/**
 * Each template is a fixed, curated set of `TemplateAccountDef`s. Flags
 * only ever filter which of these accounts are included — they never alter
 * a code or a name.
 */
const TEMPLATES: Record<TemplateKey, TemplateAccountDef[]> = {
  TRADES: [
    ...COMMON_ASSETS,
    INVENTORY_ASSET,
    { code: "1500", name: "Vehicles", type: "ASSET", subType: "Fixed Asset" },
    {
      code: "1510",
      name: "Accumulated Depreciation — Vehicles",
      type: "ASSET",
      subType: "Fixed Asset",
    },
    { code: "1520", name: "Tools & Equipment", type: "ASSET", subType: "Fixed Asset" },
    ...COMMON_LIABILITIES,
    ...PAYROLL_LIABILITIES,
    LOAN_LIABILITY,
    ...COMMON_EQUITY,
    { code: "4000", name: "Installation & Contracting Revenue", type: "REVENUE" },
    { code: "4100", name: "Maintenance & Repair Revenue", type: "REVENUE" },
    { code: "4200", name: "Materials Sales Revenue", type: "REVENUE", includeIf: (f) => f.sellsGoods },
    ...GOODS_COGS,
    {
      code: "5200",
      name: "Subcontractor Costs",
      type: "EXPENSE",
      subType: "Cost of Sales",
    },
    {
      code: "5300",
      name: "Materials & Supplies",
      type: "EXPENSE",
      subType: "Cost of Sales",
    },
    ...PAYROLL_EXPENSES,
    { code: "6200", name: "Vehicle Expenses", type: "EXPENSE" },
    { code: "6250", name: "Electricity & Utilities", type: "EXPENSE" },
    ...COMMON_OPERATING_EXPENSES,
    { code: "6950", name: "Motor Vehicle Fuel", type: "EXPENSE" },
  ],

  PROFESSIONAL_SERVICES: [
    ...COMMON_ASSETS,
    { code: "1300", name: "Work in Progress", type: "ASSET", subType: "Current Asset" },
    { code: "1520", name: "Office Equipment", type: "ASSET", subType: "Fixed Asset" },
    ...COMMON_LIABILITIES,
    ...PAYROLL_LIABILITIES,
    ...COMMON_EQUITY,
    { code: "4000", name: "Consulting & Advisory Fees", type: "REVENUE" },
    { code: "4100", name: "Retainer Revenue", type: "REVENUE" },
    { code: "4200", name: "Disbursements Recovered", type: "REVENUE" },
    ...PAYROLL_EXPENSES,
    { code: "6100", name: "Subcontractor & Associate Fees", type: "EXPENSE" },
    { code: "6150", name: "Professional Indemnity Insurance", type: "EXPENSE" },
    { code: "6250", name: "Software & Subscriptions", type: "EXPENSE" },
    { code: "6350", name: "Continuing Education & Licensing", type: "EXPENSE" },
    ...COMMON_OPERATING_EXPENSES,
    { code: "6975", name: "Travel & Client Entertainment", type: "EXPENSE" },
  ],

  RETAIL: [
    ...COMMON_ASSETS,
    { ...INVENTORY_ASSET, includeIf: () => true },
    { code: "1520", name: "Store Fixtures & Fittings", type: "ASSET", subType: "Fixed Asset" },
    { code: "1530", name: "Point-of-Sale Equipment", type: "ASSET", subType: "Fixed Asset" },
    ...COMMON_LIABILITIES,
    ...PAYROLL_LIABILITIES,
    LOAN_LIABILITY,
    ...COMMON_EQUITY,
    { code: "4000", name: "Sales Revenue — In Store", type: "REVENUE" },
    { code: "4050", name: "Sales Revenue — Online", type: "REVENUE" },
    { code: "4100", name: "Service & Repair Revenue", type: "REVENUE", includeIf: (f) => f.sellsServices },
    { code: "4900", name: "Sales Returns & Allowances", type: "REVENUE", subType: "Contra Revenue" },
    { code: "5000", name: "Cost of Goods Sold", type: "EXPENSE", subType: "Cost of Sales" },
    { code: "5100", name: "Freight & Shipping (COGS)", type: "EXPENSE", subType: "Cost of Sales" },
    { code: "5150", name: "Merchant & Payment Processing Fees", type: "EXPENSE", subType: "Cost of Sales" },
    { code: "5200", name: "Inventory Shrinkage & Write-offs", type: "EXPENSE", subType: "Cost of Sales" },
    ...PAYROLL_EXPENSES,
    { code: "6250", name: "Electricity & Utilities", type: "EXPENSE" },
    { code: "6300", name: "Ecommerce Platform Fees", type: "EXPENSE" },
    ...COMMON_OPERATING_EXPENSES,
    { code: "6975", name: "Marketing & Advertising", type: "EXPENSE" },
  ],

  HOSPITALITY: [
    ...COMMON_ASSETS,
    { ...INVENTORY_ASSET, includeIf: () => true },
    { code: "1520", name: "Kitchen Equipment", type: "ASSET", subType: "Fixed Asset" },
    { code: "1530", name: "Furniture & Fittings", type: "ASSET", subType: "Fixed Asset" },
    ...COMMON_LIABILITIES,
    ...PAYROLL_LIABILITIES,
    LOAN_LIABILITY,
    ...COMMON_EQUITY,
    { code: "4000", name: "Food Sales", type: "REVENUE" },
    { code: "4050", name: "Beverage Sales", type: "REVENUE" },
    { code: "4100", name: "Catering & Events Revenue", type: "REVENUE" },
    { code: "5000", name: "Cost of Food Sold", type: "EXPENSE", subType: "Cost of Sales" },
    { code: "5050", name: "Cost of Beverage Sold", type: "EXPENSE", subType: "Cost of Sales" },
    { code: "5150", name: "Merchant & Payment Processing Fees", type: "EXPENSE", subType: "Cost of Sales" },
    ...PAYROLL_EXPENSES,
    { code: "6250", name: "Electricity, Gas & Water", type: "EXPENSE" },
    { code: "6260", name: "Kitchen & Cleaning Supplies", type: "EXPENSE" },
    { code: "6280", name: "Licensing & Food Safety Compliance", type: "EXPENSE" },
    ...COMMON_OPERATING_EXPENSES,
    { code: "6975", name: "Marketing & Advertising", type: "EXPENSE" },
  ],

  GENERAL: [
    ...COMMON_ASSETS,
    INVENTORY_ASSET,
    { code: "1520", name: "Equipment", type: "ASSET", subType: "Fixed Asset" },
    ...COMMON_LIABILITIES,
    ...PAYROLL_LIABILITIES,
    ...COMMON_EQUITY,
    { code: "4000", name: "Service Revenue", type: "REVENUE", includeIf: (f) => f.sellsServices },
    { code: "4050", name: "Sales Revenue", type: "REVENUE", includeIf: (f) => f.sellsGoods },
    { code: "4200", name: "Other Income", type: "REVENUE" },
    ...GOODS_COGS,
    ...PAYROLL_EXPENSES,
    { code: "6100", name: "Contractor & Subcontractor Costs", type: "EXPENSE" },
    ...COMMON_OPERATING_EXPENSES,
    { code: "6975", name: "Marketing & Advertising", type: "EXPENSE" },
  ],
};

/**
 * Deterministically expands `templateKey` into the concrete account list for
 * these flags. This — never the AI — decides the final codes/names. Always
 * returns at least one ASSET, one LIABILITY, and one EQUITY account.
 */
export function expandTemplate(templateKey: TemplateKey, flags: ClassificationFlags): TemplateAccount[] {
  const defs = TEMPLATES[templateKey] ?? TEMPLATES.GENERAL;
  const seen = new Set<string>();
  const out: TemplateAccount[] = [];
  for (const def of defs) {
    if (def.includeIf && !def.includeIf(flags)) continue;
    if (seen.has(def.code)) continue;
    seen.add(def.code);
    const { includeIf: _includeIf, ...account } = def;
    out.push(account);
  }
  return out;
}

export function groupAccounts(accounts: TemplateAccount[]): Record<AccountGroup, TemplateAccount[]> {
  const groups: Record<AccountGroup, TemplateAccount[]> = {
    ASSET: [],
    LIABILITY: [],
    EQUITY: [],
    REVENUE: [],
    EXPENSE: [],
  };
  for (const account of accounts) {
    groups[account.type].push(account);
  }
  return groups;
}
