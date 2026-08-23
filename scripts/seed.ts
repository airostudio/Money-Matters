/**
 * Seeds a demonstrable demo organization — Northstar Electrical Group, an
 * Australian electrical contractor — per docs/roadmap.md's Phase 1 seed
 * requirement (master spec §71, scaled to what Phase 1 actually models:
 * chart of accounts, fiscal periods, tax codes, contacts, and journal
 * entries; there is no Invoice/Bill/Employee entity yet).
 *
 * Every posting goes through PostingService exactly as the UI would, so the
 * seed data doubles as an end-to-end exercise of the real posting engine —
 * an unbalanced or otherwise invalid entry here would fail the same way it
 * would from the journal entry form.
 *
 * Run with `npm run db:seed` against a fresh database. Not idempotent —
 * re-running against the same database fails on the org slug conflict.
 */
import { UserService } from "@/domain/auth/user-service";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { AccountService, type AccountType } from "@/domain/accounts/account-service";
import { ContactService, type ContactKind } from "@/domain/contacts/contact-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { FiscalPeriodService } from "@/domain/ledger/fiscal-period-service";
import { PostingService } from "@/domain/ledger/posting-service";
import type { Actor } from "@/domain/permissions/permission-service";
import type { JournalLineDraft } from "@/domain/ledger/types";

const OWNER_EMAIL = "owner@northstar.example";
const OWNER_PASSWORD = "NorthstarDemo123!";
const CURRENCY = "AUD";

const ACCOUNTS: Array<{ code: string; name: string; type: AccountType; subType?: string }> = [
  { code: "1000", name: "Business Bank Account", type: "ASSET", subType: "Bank" },
  { code: "1010", name: "Business Savings Account", type: "ASSET", subType: "Bank" },
  { code: "1100", name: "Accounts Receivable", type: "ASSET", subType: "Current Asset" },
  { code: "1200", name: "Electrical Supplies Inventory", type: "ASSET", subType: "Current Asset" },
  { code: "1500", name: "Vehicles", type: "ASSET", subType: "Fixed Asset" },
  { code: "1510", name: "Accumulated Depreciation — Vehicles", type: "ASSET", subType: "Fixed Asset" },
  { code: "1520", name: "Tools & Equipment", type: "ASSET", subType: "Fixed Asset" },
  { code: "2000", name: "Accounts Payable", type: "LIABILITY", subType: "Current Liability" },
  { code: "2100", name: "GST Payable", type: "LIABILITY", subType: "Current Liability" },
  { code: "2200", name: "PAYG Withholding Payable", type: "LIABILITY", subType: "Current Liability" },
  { code: "2300", name: "Superannuation Payable", type: "LIABILITY", subType: "Current Liability" },
  { code: "2400", name: "Business Credit Card", type: "LIABILITY", subType: "Current Liability" },
  { code: "3100", name: "Owner's Drawings", type: "EQUITY" },
  { code: "4000", name: "Electrical Installation Revenue", type: "REVENUE" },
  { code: "4100", name: "Maintenance & Repair Revenue", type: "REVENUE" },
  { code: "4200", name: "Interest Income", type: "REVENUE" },
  { code: "6000", name: "Wages & Salaries", type: "EXPENSE" },
  { code: "6100", name: "Subcontractor Costs", type: "EXPENSE" },
  { code: "6200", name: "Vehicle Expenses", type: "EXPENSE" },
  { code: "6250", name: "Electricity & Utilities", type: "EXPENSE" },
  { code: "6300", name: "Materials & Supplies", type: "EXPENSE" },
  { code: "6400", name: "Rent", type: "EXPENSE" },
  { code: "6500", name: "Insurance", type: "EXPENSE" },
  { code: "6600", name: "Telephone & Internet", type: "EXPENSE" },
  { code: "6700", name: "Bank Fees", type: "EXPENSE" },
  { code: "6800", name: "Depreciation Expense", type: "EXPENSE" },
  { code: "6900", name: "Motor Vehicle Fuel", type: "EXPENSE" },
];

const CUSTOMERS = [
  "Meridian Property Group",
  "Coastal Retail Holdings",
  "Bayside Shire Council",
  "Anderson Family Residence",
  "Metro Construction Pty Ltd",
  "Sunrise Early Learning Centre",
];

const SUPPLIERS = [
  "Sparkway Electrical Wholesale",
  "AusCable & Conduit Supplies",
  "Fleet Fuel Co",
  "Statewide Energy Retailer",
  "TechTools Hire",
];

interface LineSpec {
  account: string;
  debit?: number;
  credit?: number;
  contact?: string;
  taxCode?: string;
  memo?: string;
}

async function main() {
  console.log("Seeding Northstar Electrical Group...\n");

  const owner = await UserService.register({
    email: OWNER_EMAIL,
    name: "Alex Northstar",
    password: OWNER_PASSWORD,
  });

  const org = await OrganizationService.createWithOwner(owner.id, {
    slug: "northstar-electrical",
    name: "Northstar Electrical Group",
    baseCurrency: CURRENCY,
    country: "AU",
    industry: "Electrical contracting",
  });

  const actor: Actor = { userId: owner.id, organizationId: org.id, role: "OWNER" };

  // --- Chart of accounts ---------------------------------------------
  const accountIds: Record<string, string> = {};
  for (const def of ACCOUNTS) {
    const account = await AccountService.create(actor, { ...def, currency: CURRENCY });
    accountIds[def.code] = account.id;
  }
  // OrganizationService.createWithOwner already seeded the starter system
  // accounts (3000 Opening Balance Equity, 3900 Retained Earnings) — pull
  // their ids in too so the journal entries below can reference them.
  for (const systemAccount of await AccountService.list(actor)) {
    accountIds[systemAccount.code] ??= systemAccount.id;
  }
  console.log(`Created ${ACCOUNTS.length} accounts (plus the 2 starter system accounts).`);

  // --- Tax codes --------------------------------------------------------
  const gst = await TaxCodeService.create(actor, {
    code: "GST",
    name: "GST on Income/Expenses",
    rate: "0.1000",
    jurisdiction: "AU",
    effectiveFrom: new Date("2000-07-01"),
  });
  const gstFree = await TaxCodeService.create(actor, {
    code: "GST_FREE",
    name: "GST Free",
    rate: "0.0000",
    jurisdiction: "AU",
    effectiveFrom: new Date("2000-07-01"),
  });
  const taxCodeIds: Record<string, string> = { GST: gst.id, GST_FREE: gstFree.id };
  console.log("Created 2 tax codes (GST, GST Free).");

  // --- Fiscal periods -----------------------------------------------
  const priorYear = await FiscalPeriodService.create(actor, {
    label: "FY2026",
    startDate: new Date("2025-07-01"),
    endDate: new Date("2026-06-30"),
  });
  await FiscalPeriodService.setStatus(actor, priorYear.id, "HARD_LOCKED", "Prior financial year closed and filed.");
  await FiscalPeriodService.create(actor, {
    label: "FY2027",
    startDate: new Date("2026-07-01"),
    endDate: new Date("2027-06-30"),
  });
  console.log("Created 2 fiscal years (FY2026 locked, FY2027 open).");

  // --- Contacts -----------------------------------------------------
  const contactIds: Record<string, string> = {};
  for (const name of CUSTOMERS) {
    const contact = await ContactService.create(actor, {
      kind: "CUSTOMER" as ContactKind,
      displayName: name,
      currency: CURRENCY,
    });
    contactIds[name] = contact.id;
  }
  for (const name of SUPPLIERS) {
    const contact = await ContactService.create(actor, {
      kind: "SUPPLIER" as ContactKind,
      displayName: name,
      currency: CURRENCY,
    });
    contactIds[name] = contact.id;
  }
  console.log(`Created ${CUSTOMERS.length} customers and ${SUPPLIERS.length} suppliers.`);

  // --- Journal entries ------------------------------------------------
  function toLines(specs: LineSpec[]): JournalLineDraft[] {
    return specs.map((s) => ({
      accountId: accountIds[s.account] ?? (() => {
        throw new Error(`Unknown account code "${s.account}" in seed data.`);
      })(),
      debit: s.debit !== undefined ? s.debit.toFixed(2) : undefined,
      credit: s.credit !== undefined ? s.credit.toFixed(2) : undefined,
      currency: CURRENCY,
      contactId: s.contact ? contactIds[s.contact] : undefined,
      taxCodeId: s.taxCode ? taxCodeIds[s.taxCode] : undefined,
      memo: s.memo,
    }));
  }

  async function post(
    date: string,
    memo: string,
    lines: LineSpec[],
    sourceType: "MANUAL" | "OPENING_BALANCE" | "SYSTEM" = "MANUAL",
  ) {
    return PostingService.postJournal(actor, {
      postingDate: new Date(date),
      memo,
      sourceType,
      lines: toLines(lines),
    });
  }

  await post(
    "2026-07-01",
    "Opening balances as at 1 July 2026",
    [
      { account: "1000", debit: 45000.0 },
      { account: "1100", debit: 12500.0 },
      { account: "1500", debit: 68000.0 },
      { account: "1520", debit: 15000.0 },
      { account: "1510", credit: 18000.0 },
      { account: "2000", credit: 8200.0 },
      { account: "2300", credit: 2100.0 },
      { account: "3000", credit: 112200.0 },
    ],
    "OPENING_BALANCE",
  );

  await post("2026-07-01", "Rent — July", [
    { account: "6400", debit: 2909.09, taxCode: "GST" },
    { account: "2100", debit: 290.91 },
    { account: "1000", credit: 3200.0 },
  ]);

  await post("2026-07-03", "Installation — Meridian Property Group, Unit 4 rewire", [
    { account: "1100", debit: 6600.0, contact: "Meridian Property Group" },
    { account: "4000", credit: 6000.0, taxCode: "GST", contact: "Meridian Property Group" },
    { account: "2100", credit: 600.0 },
  ]);

  await post("2026-07-05", "Materials — Sparkway Electrical Wholesale", [
    { account: "6300", debit: 1650.0, taxCode: "GST", contact: "Sparkway Electrical Wholesale" },
    { account: "2100", debit: 165.0 },
    { account: "1000", credit: 1815.0, contact: "Sparkway Electrical Wholesale" },
  ]);

  await post("2026-07-06", "Fuel — Fleet Fuel Co", [
    { account: "6900", debit: 145.45, taxCode: "GST", contact: "Fleet Fuel Co" },
    { account: "2100", debit: 14.55 },
    { account: "2400", credit: 160.0, contact: "Fleet Fuel Co" },
  ]);

  await post("2026-07-08", "Insurance — annual public liability instalment", [
    { account: "6500", debit: 1200.0, taxCode: "GST_FREE" },
    { account: "1000", credit: 1200.0 },
  ]);

  await post("2026-07-10", "Payment received — Meridian Property Group", [
    { account: "1000", debit: 6600.0, contact: "Meridian Property Group" },
    { account: "1100", credit: 6600.0, contact: "Meridian Property Group" },
  ]);

  await post("2026-07-15", "Wages — fortnight ending 14 July", [
    { account: "6000", debit: 18500.0 },
    { account: "1000", credit: 18500.0 },
  ]);

  await post("2026-07-18", "Repair callout — Coastal Retail Holdings", [
    { account: "1100", debit: 4400.0, contact: "Coastal Retail Holdings" },
    { account: "4100", credit: 4000.0, taxCode: "GST", contact: "Coastal Retail Holdings" },
    { account: "2100", credit: 400.0 },
  ]);

  await post("2026-07-20", "Supplies on account — AusCable & Conduit Supplies", [
    { account: "1200", debit: 2727.27, taxCode: "GST", contact: "AusCable & Conduit Supplies" },
    { account: "2100", debit: 272.73 },
    { account: "2000", credit: 3000.0, contact: "AusCable & Conduit Supplies" },
  ]);

  await post("2026-07-22", "Electricity — Statewide Energy Retailer", [
    { account: "6250", debit: 436.36, taxCode: "GST", contact: "Statewide Energy Retailer" },
    { account: "2100", debit: 43.64 },
    { account: "1000", credit: 480.0, contact: "Statewide Energy Retailer" },
  ]);

  await post("2026-07-25", "Payment received — Coastal Retail Holdings", [
    { account: "1000", debit: 4400.0, contact: "Coastal Retail Holdings" },
    { account: "1100", credit: 4400.0, contact: "Coastal Retail Holdings" },
  ]);

  await post("2026-07-28", "Switchboard upgrade — Bayside Shire Council depot", [
    { account: "1100", debit: 22000.0, contact: "Bayside Shire Council" },
    { account: "4000", credit: 20000.0, taxCode: "GST", contact: "Bayside Shire Council" },
    { account: "2100", credit: 2000.0 },
  ]);

  await post(
    "2026-07-31",
    "Depreciation — vehicles, July",
    [
      { account: "6800", debit: 850.0 },
      { account: "1510", credit: 850.0 },
    ],
    "SYSTEM",
  );

  await post("2026-08-01", "Rent — August", [
    { account: "6400", debit: 2909.09, taxCode: "GST" },
    { account: "2100", debit: 290.91 },
    { account: "1000", credit: 3200.0 },
  ]);

  await post("2026-08-01", "Phone & internet — August", [
    { account: "6600", debit: 245.0, taxCode: "GST" },
    { account: "2100", debit: 24.5 },
    { account: "2400", credit: 269.5 },
  ]);

  await post("2026-08-01", "Bill paid — AusCable & Conduit Supplies", [
    { account: "2000", debit: 3000.0, contact: "AusCable & Conduit Supplies" },
    { account: "1000", credit: 3000.0, contact: "AusCable & Conduit Supplies" },
  ]);

  await post("2026-08-05", "New switchboard install — Metro Construction Pty Ltd", [
    { account: "1100", debit: 8800.0, contact: "Metro Construction Pty Ltd" },
    { account: "4000", credit: 8000.0, taxCode: "GST", contact: "Metro Construction Pty Ltd" },
    { account: "2100", credit: 800.0 },
  ]);

  await post("2026-08-06", "Subcontractor — additional labour on Metro Construction job", [
    { account: "6100", debit: 3636.36, taxCode: "GST" },
    { account: "2100", debit: 363.64 },
    { account: "1000", credit: 4000.0 },
  ]);

  await post("2026-08-08", "Power point additions — Anderson Family Residence", [
    { account: "1100", debit: 990.0, contact: "Anderson Family Residence" },
    { account: "4100", credit: 900.0, taxCode: "GST", contact: "Anderson Family Residence" },
    { account: "2100", credit: 90.0 },
  ]);

  const duplicateFuelEntry = await post("2026-08-09", "Fuel — Fleet Fuel Co (entered in error, duplicate receipt)", [
    { account: "6900", debit: 145.45, taxCode: "GST", contact: "Fleet Fuel Co" },
    { account: "2100", debit: 14.55 },
    { account: "2400", credit: 160.0, contact: "Fleet Fuel Co" },
  ]);
  await PostingService.reverseEntry(
    actor,
    duplicateFuelEntry.entryId,
    "Same fuel receipt was entered twice — reversing the duplicate.",
    new Date("2026-08-10"),
  );

  await post("2026-08-10", "Bank fees — August", [
    { account: "6700", debit: 45.0 },
    { account: "1000", credit: 45.0 },
  ]);

  await post("2026-08-12", "Equipment hire — TechTools Hire", [
    { account: "6300", debit: 454.55, taxCode: "GST", contact: "TechTools Hire" },
    { account: "2100", debit: 45.45 },
    { account: "2400", credit: 500.0, contact: "TechTools Hire" },
  ]);

  await post("2026-08-15", "Payment received — Anderson Family Residence", [
    { account: "1000", debit: 990.0, contact: "Anderson Family Residence" },
    { account: "1100", credit: 990.0, contact: "Anderson Family Residence" },
  ]);

  await post("2026-08-18", "Interest — business savings account", [
    { account: "1010", debit: 32.5 },
    { account: "4200", credit: 32.5 },
  ]);

  await post("2026-08-19", "New childcare centre wiring — Sunrise Early Learning Centre", [
    { account: "1100", debit: 3300.0, contact: "Sunrise Early Learning Centre" },
    { account: "4000", credit: 3000.0, taxCode: "GST", contact: "Sunrise Early Learning Centre" },
    { account: "2100", credit: 300.0 },
  ]);

  await post("2026-08-20", "Owner's drawings", [
    { account: "3100", debit: 5000.0 },
    { account: "1000", credit: 5000.0 },
  ]);

  console.log("Posted 28 journal entries (27 originals, plus 1 reversal of a duplicate entry).\n");
  console.log("Northstar Electrical Group is ready:");
  console.log(`  URL:      http://localhost:3000/${org.slug}`);
  console.log(`  Email:    ${OWNER_EMAIL}`);
  console.log(`  Password: ${OWNER_PASSWORD}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
