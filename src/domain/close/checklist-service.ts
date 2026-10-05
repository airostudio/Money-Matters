import { and, count, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  accounts,
  bankAccounts,
  bankTransactions,
  bills,
  budgets,
  closeSignoffs,
  expenseClaims,
  fixedAssets,
  invoices,
  journalEntries,
  journalLines,
  organizations,
  payRuns,
  periodCloses,
  products,
  supplierCreditNotes,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission, type Permission } from "@/domain/permissions/roles";
import { FixedAssetRegisterService } from "@/domain/fixed-assets/fixed-asset-register-service";
import { InventoryValuationService } from "@/domain/inventory/valuation-service";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { findFiscalPeriod } from "@/domain/ledger/posting-service";
import { isLocked } from "@/domain/ledger/period-lock";
import { normalBalanceSide } from "@/domain/ledger/ledger-service";
import {
  balanceSheetItem,
  bankingItems,
  classifyItems,
  computeProgress,
  depreciationItem,
  draftDocumentItem,
  draftJournalsItem,
  manualItems,
  priorPeriodItem,
  reconciliationItem,
  suspenseItem,
  trialBalanceItem,
  type BankAccountMeasure,
  type SuspenseAccountMeasure,
} from "./checklist-items";
import { CATEGORY_ORDER, type ChecklistItem, type PeriodChecklist, type SignoffInfo } from "./checklist-types";
import { dayBefore, endOfDayUtc, monthKeyOf, monthStartOf, type PeriodRef } from "./period-ref";
import { resolvePeriod, type ResolvedPeriod } from "./period-resolution";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function money2(value: string | number | null | undefined): string {
  return new Decimal(value ?? 0).toFixed(2);
}

/** Account-name heuristic for suspense/clearing accounts — the platform creates none by default, so this only finds accounts the organization itself named that way. */
const SUSPENSE_NAME_PATTERNS = ["%suspense%", "%clearing%", "%undeposited%"];

interface Measurements {
  baseCurrency: string;
  banks: BankAccountMeasure[] | null;
  draftInvoices: { count: number; amount: string } | null;
  draftBills: { count: number; amount: string } | null;
  draftCredits: { count: number; amount: string } | null;
  submittedClaims: { count: number; amount: string } | null;
  draftPayRuns: { count: number; amount: string } | null;
  assets: { active: number; eligible: number; missing: number } | null;
  trackedProducts: number | null;
  trialBalance: { debit: string; credit: string } | null;
  suspense: SuspenseAccountMeasure[] | null;
  draftJournals: number | null;
  previous: { label: string; locked: boolean } | null | undefined;
  fxLineCount: number;
  budgetCount: number;
  signoffs: Map<string, SignoffInfo>;
}

/**
 * The live month-end checklist (master spec §40). Every AUTOMATIC item is
 * recomputed from real data on every call — nothing is stored, so a tick can
 * never be stale — and every MANUAL item is an explicit human sign-off (identity
 * and timestamp recorded) that is never presented as system verification.
 *
 * DB-connection discipline (docs/architecture.md — a production incident was
 * fixed for this): the checks run SEQUENTIALLY, never in parallel. All of this
 * module's own queries share ONE tenant transaction (set-based aggregates, no
 * row loading); that transaction is closed before the three existing reporting
 * services (register, valuation, balance sheet) are called one at a time, so
 * at most one pooled connection is ever held.
 */
export const CloseChecklistService = {
  async compute(actor: Actor, ref: PeriodRef | string): Promise<PeriodChecklist> {
    assertPermission(actor, "close_checklist:read");
    const can = (p: Permission) => roleHasPermission(actor.role, p);

    // ---- Phase A: one transaction, set-based queries of our own ----------
    const { period, m } = await withTenant(actor.organizationId, async (tx) => {
      const period = await resolvePeriod(tx, actor.organizationId, ref);
      const from = period.start;
      const to = endOfDayUtc(period.end);
      const org = actor.organizationId;
      const m: Measurements = {
        baseCurrency: "AUD",
        banks: null,
        draftInvoices: null,
        draftBills: null,
        draftCredits: null,
        submittedClaims: null,
        draftPayRuns: null,
        assets: null,
        trackedProducts: null,
        trialBalance: null,
        suspense: null,
        draftJournals: null,
        previous: undefined,
        fxLineCount: 0,
        budgetCount: 0,
        signoffs: new Map(),
      };

      const [orgRow] = await tx
        .select({ baseCurrency: organizations.baseCurrency })
        .from(organizations)
        .where(eq(organizations.id, org));
      m.baseCurrency = orgRow?.baseCurrency ?? "AUD";

      if (can("bank_account:read")) {
        const rows = await tx
          .select({
            bankAccountId: bankAccounts.id,
            name: bankAccounts.name,
            unmatched: sql<number>`count(${bankTransactions.id})::int`,
            suggested: sql<number>`(count(${bankTransactions.id}) filter (where ${bankTransactions.categorizedAccountId} is not null))::int`,
            amount: sql<string>`coalesce(sum(abs(${bankTransactions.amount})), 0)`,
          })
          .from(bankAccounts)
          .leftJoin(
            bankTransactions,
            and(
              eq(bankTransactions.bankAccountId, bankAccounts.id),
              eq(bankTransactions.status, "UNMATCHED"),
              lte(bankTransactions.postedDate, to),
            ),
          )
          .where(and(eq(bankAccounts.organizationId, org), eq(bankAccounts.isActive, true)))
          .groupBy(bankAccounts.id, bankAccounts.name)
          .orderBy(bankAccounts.name);
        m.banks = rows.map((r) => ({
          bankAccountId: r.bankAccountId,
          name: r.name,
          unmatchedCount: Number(r.unmatched),
          ruleSuggestedCount: Number(r.suggested),
          unmatchedAbsAmount: money2(r.amount),
        }));
      }

      if (can("customer_invoice:read")) {
        const [r] = await tx
          .select({ n: count(), amount: sql<string>`coalesce(sum(${invoices.total}), 0)` })
          .from(invoices)
          .where(
            and(eq(invoices.organizationId, org), eq(invoices.status, "DRAFT"), gte(invoices.issueDate, from), lte(invoices.issueDate, to)),
          );
        m.draftInvoices = { count: Number(r?.n ?? 0), amount: money2(r?.amount) };
      }
      if (can("supplier_bill:read")) {
        const [r] = await tx
          .select({ n: count(), amount: sql<string>`coalesce(sum(${bills.total}), 0)` })
          .from(bills)
          .where(and(eq(bills.organizationId, org), eq(bills.status, "DRAFT"), gte(bills.issueDate, from), lte(bills.issueDate, to)));
        m.draftBills = { count: Number(r?.n ?? 0), amount: money2(r?.amount) };
      }
      if (can("supplier_credit:read")) {
        const [r] = await tx
          .select({ n: count(), amount: sql<string>`coalesce(sum(${supplierCreditNotes.total}), 0)` })
          .from(supplierCreditNotes)
          .where(
            and(
              eq(supplierCreditNotes.organizationId, org),
              eq(supplierCreditNotes.status, "DRAFT"),
              gte(supplierCreditNotes.issueDate, from),
              lte(supplierCreditNotes.issueDate, to),
            ),
          );
        m.draftCredits = { count: Number(r?.n ?? 0), amount: money2(r?.amount) };
      }
      if (can("expense_claim:read")) {
        const [r] = await tx
          .select({ n: count(), amount: sql<string>`coalesce(sum(${expenseClaims.total}), 0)` })
          .from(expenseClaims)
          .where(and(eq(expenseClaims.organizationId, org), eq(expenseClaims.status, "SUBMITTED"), lte(expenseClaims.claimDate, to)));
        m.submittedClaims = { count: Number(r?.n ?? 0), amount: money2(r?.amount) };
      }
      // Payroll is sensitive: only an actor holding `payrun:read` ever has this
      // measurement taken at all (same pattern as the cash forecast).
      if (can("payrun:read")) {
        const [r] = await tx
          .select({ n: count() })
          .from(payRuns)
          .where(and(eq(payRuns.organizationId, org), eq(payRuns.status, "DRAFT"), gte(payRuns.payDate, from), lte(payRuns.payDate, to)));
        m.draftPayRuns = { count: Number(r?.n ?? 0), amount: "" };
      }

      if (can("fixed_asset:read")) {
        const monthStart = monthStartOf(period.end);
        const [r] = await tx
          .select({
            active: sql<number>`count(*)::int`,
            eligible: sql<number>`(count(*) filter (where ${fixedAssets.acquisitionDate} <= ${to.toISOString()}::timestamptz))::int`,
            missing: sql<number>`(count(*) filter (where ${fixedAssets.acquisitionDate} <= ${to.toISOString()}::timestamptz and not exists (select 1 from depreciation_entries d where d.asset_id = fixed_assets.id and d.period_start = ${monthStart.toISOString()}::timestamptz)))::int`,
          })
          .from(fixedAssets)
          .where(and(eq(fixedAssets.organizationId, org), eq(fixedAssets.status, "ACTIVE")));
        m.assets = { active: Number(r?.active ?? 0), eligible: Number(r?.eligible ?? 0), missing: Number(r?.missing ?? 0) };
      }
      if (can("inventory:read")) {
        const [r] = await tx
          .select({ n: count() })
          .from(products)
          .where(and(eq(products.organizationId, org), eq(products.type, "TRACKED_INVENTORY")));
        m.trackedProducts = Number(r?.n ?? 0);
      }

      if (can("journal:read")) {
        const [tb] = await tx
          .select({
            debit: sql<string>`coalesce(sum(${journalLines.baseDebit}), 0)`,
            credit: sql<string>`coalesce(sum(${journalLines.baseCredit}), 0)`,
          })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
          .where(and(eq(journalEntries.organizationId, org), ne(journalEntries.status, "DRAFT"), lte(journalEntries.postingDate, to)));
        m.trialBalance = { debit: money2(tb?.debit), credit: money2(tb?.credit) };

        const suspenseAccounts = await tx
          .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
          .from(accounts)
          .where(and(eq(accounts.organizationId, org), eq(accounts.isActive, true), or(...SUSPENSE_NAME_PATTERNS.map((p) => ilike(accounts.name, p)))))
          .orderBy(accounts.code);
        if (suspenseAccounts.length > 0) {
          const sums = await tx
            .select({
              accountId: journalLines.accountId,
              debit: sql<string>`coalesce(sum(${journalLines.baseDebit}), 0)`,
              credit: sql<string>`coalesce(sum(${journalLines.baseCredit}), 0)`,
            })
            .from(journalLines)
            .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
            .where(
              and(
                eq(journalEntries.organizationId, org),
                ne(journalEntries.status, "DRAFT"),
                lte(journalEntries.postingDate, to),
                inArray(journalLines.accountId, suspenseAccounts.map((a) => a.id)),
              ),
            )
            .groupBy(journalLines.accountId);
          const byId = new Map(sums.map((s) => [s.accountId, s]));
          m.suspense = suspenseAccounts.map((a) => {
            const s = byId.get(a.id);
            const debit = new Decimal(s?.debit ?? 0);
            const credit = new Decimal(s?.credit ?? 0);
            const balance = normalBalanceSide(a.type) === "DEBIT" ? debit.minus(credit) : credit.minus(debit);
            return { accountId: a.id, code: a.code, name: a.name, balance: balance.toFixed(2) };
          });
        } else {
          m.suspense = [];
        }

        const [dj] = await tx
          .select({ n: count() })
          .from(journalEntries)
          .where(and(eq(journalEntries.organizationId, org), eq(journalEntries.status, "DRAFT"), gte(journalEntries.postingDate, from), lte(journalEntries.postingDate, to)));
        m.draftJournals = Number(dj?.n ?? 0);

        // Sequencing: is there posted activity before this period, and is the period before it locked?
        const [earlier] = await tx
          .select({ n: count() })
          .from(journalEntries)
          .where(and(eq(journalEntries.organizationId, org), ne(journalEntries.status, "DRAFT"), sql`${journalEntries.postingDate} < ${from.toISOString()}::timestamptz`));
        if (Number(earlier?.n ?? 0) === 0) {
          m.previous = null;
        } else {
          const prevDay = dayBefore(from);
          const governing = await findFiscalPeriod(tx, org, prevDay);
          m.previous = {
            label: governing?.label ?? monthKeyOf(prevDay),
            locked: governing ? isLocked(governing.status as never) : false,
          };
        }

        const [fx] = await tx
          .select({ n: count() })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
          .where(
            and(
              eq(journalEntries.organizationId, org),
              ne(journalEntries.status, "DRAFT"),
              gte(journalEntries.postingDate, from),
              lte(journalEntries.postingDate, to),
              ne(journalLines.currency, m.baseCurrency),
            ),
          );
        m.fxLineCount = Number(fx?.n ?? 0);
      }

      if (can("budget:read")) {
        const [b] = await tx.select({ n: count() }).from(budgets).where(eq(budgets.organizationId, org));
        m.budgetCount = Number(b?.n ?? 0);
      }

      // Sign-offs of the period's latest close cycle (none for an implicit period).
      if (period.id) {
        const [cycle] = await tx
          .select({ id: periodCloses.id })
          .from(periodCloses)
          .where(and(eq(periodCloses.organizationId, org), eq(periodCloses.fiscalPeriodId, period.id)))
          .orderBy(desc(periodCloses.cycle))
          .limit(1);
        if (cycle) {
          const rows = await tx.select().from(closeSignoffs).where(eq(closeSignoffs.periodCloseId, cycle.id));
          for (const s of rows) {
            m.signoffs.set(s.checkKey, {
              signedById: s.signedById,
              signedByName: s.signedByName,
              signedAt: s.signedAt.toISOString(),
              note: s.note,
            });
          }
        }
      }

      return { period, m };
    });

    // ---- Phase B: existing reporting services, one at a time -------------
    const to = endOfDayUtc(period.end);
    const asOf = ymd(period.end);
    const now = new Date();
    let registerMismatches: Array<{ name: string; difference: string }> | null = null;
    if (m.assets && m.assets.active > 0) {
      // Compared to the GL as of NOW, not the period end: the register holds
      // current balances, so a past-period comparison would flag later activity.
      const register = await FixedAssetRegisterService.getRegister(actor, now);
      registerMismatches = register.reconciliation
        .filter((r) => !r.reconciled)
        .map((r) => ({ name: `${r.assetAccountCode} ${r.assetAccountName}`.trim(), difference: r.difference }));
    }
    let inventoryMismatches: Array<{ name: string; difference: string }> | null = null;
    if (m.trackedProducts && m.trackedProducts > 0) {
      const valuation = await InventoryValuationService.getValuationReport(actor, now);
      inventoryMismatches = valuation.reconciliation
        .filter((r) => !r.reconciled)
        .map((r) => ({ name: `${r.accountCode} ${r.accountName}`.trim(), difference: r.difference }));
    }
    let balanceSheet: { balanced: boolean; assets: string; liabilitiesAndEquity: string; difference: string } | null = null;
    if (can("financial_report:read")) {
      const bs = await ReportingService.getBalanceSheet(actor, to);
      balanceSheet = {
        balanced: bs.isBalanced,
        assets: bs.totalAssets,
        liabilitiesAndEquity: bs.totalLiabilitiesAndEquity,
        difference: bs.difference,
      };
    }

    // ---- Assemble ---------------------------------------------------------
    const items: ChecklistItem[] = [];
    let hiddenCount = 0;
    const add = (visible: boolean, build: () => ChecklistItem | ChecklistItem[]) => {
      if (!visible) {
        hiddenCount += 1;
        return;
      }
      const built = build();
      items.push(...(Array.isArray(built) ? built : [built]));
    };

    add(m.banks !== null, () => bankingItems(m.banks!));
    add(m.draftInvoices !== null, () =>
      draftDocumentItem({ id: "sales.draft_invoices", title: "Draft invoices", category: "SALES", noun: "draft invoice", count: m.draftInvoices!.count, amount: m.draftInvoices!.count ? m.draftInvoices!.amount : null, href: "/sales/invoices?status=DRAFT", qualifier: "dated in this period still in draft (not yet approved and posted)" }),
    );
    add(m.draftBills !== null, () =>
      draftDocumentItem({ id: "purchases.draft_bills", title: "Draft bills", category: "PURCHASES", noun: "draft bill", count: m.draftBills!.count, amount: m.draftBills!.count ? m.draftBills!.amount : null, href: "/purchases/bills?status=DRAFT", qualifier: "dated in this period still in draft (not yet approved and posted)" }),
    );
    add(m.draftCredits !== null, () =>
      draftDocumentItem({ id: "purchases.draft_credits", title: "Draft supplier credit notes", category: "PURCHASES", noun: "draft supplier credit note", count: m.draftCredits!.count, amount: m.draftCredits!.count ? m.draftCredits!.amount : null, href: "/purchases/supplier-credits", qualifier: "dated in this period still in draft" }),
    );
    add(m.submittedClaims !== null, () =>
      draftDocumentItem({ id: "expenses.submitted_claims", title: "Expense claims approved", category: "EXPENSES", noun: "expense claim", count: m.submittedClaims!.count, amount: m.submittedClaims!.count ? m.submittedClaims!.amount : null, href: "/expenses?status=SUBMITTED", qualifier: "submitted on or before the period end but not yet approved" }),
    );
    add(m.draftPayRuns !== null, () =>
      draftDocumentItem({ id: "payroll.draft_pay_runs", title: "Pay runs posted", category: "PAYROLL", noun: "draft pay run", count: m.draftPayRuns!.count, amount: null, href: "/payroll/pay-runs", qualifier: "paid in this period still in draft (not yet posted)" }),
    );
    add(m.assets !== null, () => [
      depreciationItem({ eligibleAssets: m.assets!.eligible, missingAssets: m.assets!.missing, monthLabel: monthKeyOf(period.end) }),
      reconciliationItem({
        id: "assets.register_reconciles",
        title: "Fixed asset register reconciles to the ledger",
        category: "ASSETS",
        href: "/fixed-assets",
        applicable: m.assets!.active > 0,
        notApplicableDetail: "There are no active fixed assets.",
        mismatches: registerMismatches ?? [],
        passedDetail: "The fixed asset register's net book value agrees with the general ledger (compared as at today).",
      }),
    ]);
    add(m.trackedProducts !== null, () =>
      reconciliationItem({
        id: "inventory.valuation_reconciles",
        title: "Inventory valuation reconciles to the ledger",
        category: "INVENTORY",
        href: "/inventory/valuation",
        applicable: (m.trackedProducts ?? 0) > 0,
        notApplicableDetail: "There are no tracked-inventory products.",
        mismatches: inventoryMismatches ?? [],
        passedDetail: "Inventory valuation agrees with the inventory asset accounts in the general ledger (compared as at today).",
      }),
    );
    add(m.trialBalance !== null, () => [
      trialBalanceItem({ totalDebit: m.trialBalance!.debit, totalCredit: m.trialBalance!.credit, asOf }),
      suspenseItem(m.suspense ?? []),
      draftJournalsItem({ count: m.draftJournals ?? 0 }),
      priorPeriodItem({ previous: m.previous ?? null }),
    ]);
    add(balanceSheet !== null, () =>
      balanceSheetItem({ ...balanceSheet!, asOf }),
    );

    const manual = manualItems({
      fxLineCount: m.fxLineCount,
      baseCurrency: m.baseCurrency,
      budgetCount: m.budgetCount,
      canSeeBudgets: can("budget:read"),
      from: ymd(period.start),
      to: asOf,
      signoffs: m.signoffs,
    });
    items.push(...manual.items);
    hiddenCount += manual.hiddenCount;

    items.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
    return buildChecklist(period, items, hiddenCount);
  },
};

export function buildChecklist(period: ResolvedPeriod, items: ChecklistItem[], hiddenCount: number): PeriodChecklist {
  const { remaining, blocking, outstanding } = classifyItems(items);
  return {
    period: {
      key: period.key,
      fiscalPeriodId: period.id,
      label: period.label,
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      lockLevel: period.lockLevel,
    },
    items,
    hiddenCount,
    progress: computeProgress(items),
    remaining,
    blocking,
    outstanding,
    generatedAt: new Date().toISOString(),
  };
}
