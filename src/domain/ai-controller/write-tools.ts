import "server-only";
import { z } from "zod";
import Decimal from "decimal.js";
import { assertPermission, type Actor, PermissionDeniedError } from "@/domain/permissions/permission-service";
import type { Permission } from "@/domain/permissions/roles";
import { ContactService } from "@/domain/contacts/contact-service";
import { AccountService, type AccountType } from "@/domain/accounts/account-service";
import { calculateInvoiceTotals } from "@/domain/sales/invoice-calculations";
import { calculateBillTotals } from "@/domain/purchases/bill-calculations";
import { Money } from "@/domain/money/money";
import { AIDraftProposalService, type DraftProposalPreviewLine } from "./draft-proposal-service";
import type { ControllerToolDefinition, ToolOutcome } from "./controller-tools";
import { formatDateParam } from "@/domain/reporting/period-presets";

/**
 * Master spec §80/§87.4's "prepare, never post" write tools — Phase 6 Slice
 * 2. Every tool here follows the exact same wrapper discipline
 * `controller-tools.ts`'s doc comment establishes for the read-only tools
 * (thin delegation, the real `Actor`'s real permission, `guarded()` turning
 * a `PermissionDeniedError` into a plain refusal), with one addition: a
 * successful call here NEVER writes an invoice/bill/journal-entry row. It
 * resolves the model's request against REAL organization data (a real
 * contact, real accounts — an id or name the model merely claims but that
 * isn't actually in this organization is a hard failure, never a guess,
 * exactly like `run_report`'s dimension matching and `0a`'s candidate-id
 * matching) and stores the result as a PENDING `AIDraftProposalService`
 * row. The model's tool_result is told a proposal was prepared for human
 * review — not that anything was created. Only a separate, explicit user
 * click (`confirm-draft-proposal-action.ts`) ever calls
 * `AIDraftProposalService.confirm`, which is the ONLY path that reaches
 * `InvoiceService.create`/`BillService.create`/`PostingService.createDraft`.
 *
 * **These tools are only ever offered to the model at autonomy Level 2** —
 * see `buildWriteTools`'s caller in `financial-controller-service.ts`,
 * which does not even construct this array below Level 2. This is the
 * "checked before it's even offered to the model" gate the task describes:
 * there is no code path where a Level 0/1 organization's conversation ever
 * sees a tool named `prepare_draft_*` in its `tools` array at all.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OptionalDateArg = z.string().regex(DATE_RE).optional();

function parseDateArg(value: string | undefined, fallbackDaysFromNow: number): Date {
  if (value) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!));
  }
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + fallbackDaysFromNow);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function guardedWrite(fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      return {
        ok: false,
        error: `Access denied: your role does not have the "${err.permission}" permission needed to prepare this draft, the same as it would be denied in the application itself.`,
      };
    }
    if (err instanceof Error) {
      // Domain validation errors (InvalidInvoiceLineError, InvalidContactForInvoiceError,
      // UnbalancedJournalError, ...) carry a safe, user-facing message —
      // relay it so the model can explain what needs fixing, rather than a
      // generic failure.
      return { ok: false, error: err.message };
    }
    return { ok: false, error: "That draft could not be prepared." };
  }
}

interface ResolvedAccount {
  id: string;
  code: string;
  name: string;
}

/** Never trusts an account name/code the model merely claims — only ever returns one that is actually in this organization's chart of accounts. */
function findAccountsByQuery<T extends { id: string; code: string; name: string; type: string; isActive: boolean }>(
  accounts: T[],
  type: AccountType,
  query: string | undefined,
): { matches: T[]; label: string } {
  const pool = accounts.filter((a) => a.type === type && a.isActive);
  if (!query) return { matches: pool, label: `any ${type.toLowerCase()} account` };
  const q = query.trim().toLowerCase();
  const matches = pool.filter((a) => a.code.toLowerCase() === q || a.name.toLowerCase() === q);
  if (matches.length > 0) return { matches, label: query };
  const fuzzy = pool.filter((a) => a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
  return { matches: fuzzy, label: query };
}

function accountOptionsList(accounts: ResolvedAccount[]): string {
  return accounts.map((a) => `${a.code} ${a.name}`).join(", ") || "none configured";
}

const LineArgSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.string().max(30).optional(),
  unitPrice: z.string().min(1).max(30),
  accountName: z.string().max(200).optional().describe("Exact or partial account code/name. Omit only if the organization has exactly one usable account of the right type."),
});

const PrepareInvoiceArgsSchema = z.object({
  customerName: z.string().min(1).max(200),
  issueDate: OptionalDateArg,
  dueDate: OptionalDateArg,
  memo: z.string().max(500).optional(),
  lines: z.array(LineArgSchema).min(1).max(20),
});

const PrepareBillArgsSchema = z.object({
  supplierName: z.string().min(1).max(200),
  issueDate: OptionalDateArg,
  dueDate: OptionalDateArg,
  memo: z.string().max(500).optional(),
  lines: z.array(LineArgSchema).min(1).max(20),
});

const JournalLineArgSchema = z.object({
  accountName: z.string().min(1).max(200),
  debit: z.string().max(30).optional(),
  credit: z.string().max(30).optional(),
  memo: z.string().max(200).optional(),
});

const PrepareJournalEntryArgsSchema = z.object({
  postingDate: OptionalDateArg,
  memo: z.string().max(500).optional(),
  lines: z.array(JournalLineArgSchema).min(2).max(20),
});

/**
 * Built only when the org's autonomy level is >= 2 (see this module's doc
 * comment). Takes no dimensions/other per-conversation context today, but
 * keeps the same factory-function shape as `buildControllerTools` for
 * consistency and so a future write tool needing context fits the same way.
 */
export function buildWriteTools(question: string, model: string): ControllerToolDefinition[] {
  return [
    {
      name: "prepare_draft_invoice",
      description:
        "Prepare a DRAFT customer invoice for human review — this NEVER creates the invoice itself. It resolves the customer and revenue account(s) against real records and stores a proposal the user must explicitly confirm in the chat UI before anything is created. Use this when the user asks to invoice/bill a customer.",
      inputSchema: {
        type: "object",
        properties: {
          customerName: { type: "string", description: "The customer's name, or part of it." },
          issueDate: { type: "string", description: "YYYY-MM-DD, defaults to today." },
          dueDate: { type: "string", description: "YYYY-MM-DD, defaults to 30 days from issue." },
          memo: { type: "string" },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                quantity: { type: "string", description: "Decimal string, defaults to 1." },
                unitPrice: { type: "string", description: "Decimal string, e.g. '3500.00'." },
                accountName: { type: "string", description: "Revenue account name/code, only if the organization has more than one." },
              },
              required: ["description", "unitPrice"],
            },
          },
        },
        required: ["customerName", "lines"],
      },
      argsSchema: PrepareInvoiceArgsSchema,
      permission: "customer_invoice:manage",
      execute: (actor, rawArgs) =>
        guardedWrite(async () => {
          // Preparing a proposal is itself gated on the SAME permission the
          // eventual `InvoiceService.create` call enforces at confirm time —
          // a role that couldn't create this invoice through the UI must not
          // even be able to get as far as a proposal being shown to them.
          assertPermission(actor, "customer_invoice:manage");
          const args = PrepareInvoiceArgsSchema.parse(rawArgs);

          const customers = await ContactService.list(actor, { kind: "CUSTOMER" });
          const customersBoth = await ContactService.list(actor, { kind: "BOTH" });
          const allCustomers = [...customers, ...customersBoth];
          const q = args.customerName.trim().toLowerCase();
          const custMatches = allCustomers.filter((c) => c.displayName.toLowerCase().includes(q));
          if (custMatches.length === 0) {
            return { ok: false, error: `No customer found matching "${args.customerName}". Check the spelling or create the customer first.` };
          }
          if (custMatches.length > 1) {
            return {
              ok: false,
              error: `More than one customer matches "${args.customerName}": ${custMatches.map((c) => c.displayName).join(", ")}. Please be more specific.`,
            };
          }
          const customer = custMatches[0]!;

          const accounts = await AccountService.list(actor);
          const assetAccounts = accounts.filter((a) => a.type === "ASSET" && a.isActive);
          const arPool = assetAccounts.filter((a) => a.isControlAccount);
          const arAccounts = arPool.length > 0 ? arPool : assetAccounts;
          if (arAccounts.length === 0) {
            return { ok: false, error: "This organization has no Accounts Receivable account configured yet." };
          }
          const arAccount = arAccounts[0]!;

          const revenuePool = accounts.filter((a) => a.type === "REVENUE" && a.isActive);
          if (revenuePool.length === 0) {
            return { ok: false, error: "This organization has no revenue account configured yet — create one before invoicing." };
          }

          const resolvedLines: { description: string; quantity: string; unitPrice: string; accountId: string; accountLabel: string }[] = [];
          for (const [i, line] of args.lines.entries()) {
            let account: ResolvedAccount;
            if (line.accountName) {
              const { matches } = findAccountsByQuery(revenuePool, "REVENUE", line.accountName);
              if (matches.length === 0) return { ok: false, error: `Line ${i + 1}: no revenue account matches "${line.accountName}". Available: ${accountOptionsList(revenuePool)}.` };
              if (matches.length > 1) return { ok: false, error: `Line ${i + 1}: "${line.accountName}" matches more than one revenue account (${accountOptionsList(matches)}) — be more specific.` };
              account = matches[0]!;
            } else if (revenuePool.length === 1) {
              account = revenuePool[0]!;
            } else {
              return { ok: false, error: `Line ${i + 1}: please specify which revenue account to use. Available: ${accountOptionsList(revenuePool)}.` };
            }
            resolvedLines.push({
              description: line.description,
              quantity: line.quantity ?? "1",
              unitPrice: line.unitPrice,
              accountId: account.id,
              accountLabel: `${account.code} ${account.name}`,
            });
          }

          const currency = customer.currency;
          let totals;
          try {
            totals = calculateInvoiceTotals(resolvedLines, currency, new Map());
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "Invalid invoice line." };
          }

          const issueDate = parseDateArg(args.issueDate, 0);
          const dueDate = parseDateArg(args.dueDate, 30);

          const previewLines: DraftProposalPreviewLine[] = resolvedLines.map((l, i) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            accountLabel: l.accountLabel,
            amount: totals!.lines[i]!.lineAmount,
          }));

          const proposal = await AIDraftProposalService.create(actor, {
            type: "INVOICE",
            payload: {
              customerContactId: customer.id,
              issueDate: formatDateParam(issueDate),
              dueDate: formatDateParam(dueDate),
              currency,
              arAccountId: arAccount.id,
              memo: args.memo,
              lines: resolvedLines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, accountId: l.accountId })),
            },
            preview: {
              type: "INVOICE",
              headline: `Draft invoice to ${customer.displayName} for ${totals!.total} ${currency}`,
              counterpartyName: customer.displayName,
              currency,
              total: totals!.total,
              memo: args.memo,
              lines: previewLines,
            },
            model,
            question,
          });

          return {
            ok: true,
            summary: `I've prepared a draft invoice to ${customer.displayName} for ${totals!.total} ${currency} (due ${formatDateParam(dueDate)}). It has NOT been created yet — show the user the confirmation card so they can review and explicitly confirm it.`,
            citation: { tool: "prepare_draft_invoice", description: `Draft invoice proposal for ${customer.displayName}` },
            proposal: { id: proposal.id, preview: proposal.preview },
          };
        }),
    },
    {
      name: "prepare_draft_bill",
      description:
        "Prepare a DRAFT supplier bill for human review — this NEVER creates the bill itself. It resolves the supplier and expense account(s) against real records and stores a proposal the user must explicitly confirm in the chat UI before anything is created. Use this when the user asks to record/enter a bill from a supplier.",
      inputSchema: {
        type: "object",
        properties: {
          supplierName: { type: "string", description: "The supplier's name, or part of it." },
          issueDate: { type: "string", description: "YYYY-MM-DD, defaults to today." },
          dueDate: { type: "string", description: "YYYY-MM-DD, defaults to 30 days from issue." },
          memo: { type: "string" },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                quantity: { type: "string", description: "Decimal string, defaults to 1." },
                unitPrice: { type: "string" },
                accountName: { type: "string", description: "Expense account name/code, only if the organization has more than one." },
              },
              required: ["description", "unitPrice"],
            },
          },
        },
        required: ["supplierName", "lines"],
      },
      argsSchema: PrepareBillArgsSchema,
      permission: "supplier_bill:manage",
      execute: (actor, rawArgs) =>
        guardedWrite(async () => {
          assertPermission(actor, "supplier_bill:manage");
          const args = PrepareBillArgsSchema.parse(rawArgs);

          const suppliers = await ContactService.list(actor, { kind: "SUPPLIER" });
          const suppliersBoth = await ContactService.list(actor, { kind: "BOTH" });
          const allSuppliers = [...suppliers, ...suppliersBoth];
          const q = args.supplierName.trim().toLowerCase();
          const supMatches = allSuppliers.filter((s) => s.displayName.toLowerCase().includes(q));
          if (supMatches.length === 0) {
            return { ok: false, error: `No supplier found matching "${args.supplierName}". Check the spelling or create the supplier first.` };
          }
          if (supMatches.length > 1) {
            return {
              ok: false,
              error: `More than one supplier matches "${args.supplierName}": ${supMatches.map((s) => s.displayName).join(", ")}. Please be more specific.`,
            };
          }
          const supplier = supMatches[0]!;

          const accounts = await AccountService.list(actor);
          const apPool = accounts.filter((a) => a.type === "LIABILITY" && a.isActive && a.isControlAccount);
          const apAccounts = apPool.length > 0 ? apPool : accounts.filter((a) => a.type === "LIABILITY" && a.isActive);
          if (apAccounts.length === 0) {
            return { ok: false, error: "This organization has no Accounts Payable account configured yet." };
          }
          const apAccount = apAccounts[0]!;

          const expensePool = accounts.filter((a) => a.type === "EXPENSE" && a.isActive);
          if (expensePool.length === 0) {
            return { ok: false, error: "This organization has no expense account configured yet — create one before entering bills." };
          }

          const resolvedLines: { description: string; quantity: string; unitPrice: string; accountId: string; accountLabel: string }[] = [];
          for (const [i, line] of args.lines.entries()) {
            let account: ResolvedAccount;
            if (line.accountName) {
              const { matches } = findAccountsByQuery(expensePool, "EXPENSE", line.accountName);
              if (matches.length === 0) return { ok: false, error: `Line ${i + 1}: no expense account matches "${line.accountName}". Available: ${accountOptionsList(expensePool)}.` };
              if (matches.length > 1) return { ok: false, error: `Line ${i + 1}: "${line.accountName}" matches more than one expense account (${accountOptionsList(matches)}) — be more specific.` };
              account = matches[0]!;
            } else if (expensePool.length === 1) {
              account = expensePool[0]!;
            } else {
              return { ok: false, error: `Line ${i + 1}: please specify which expense account to use. Available: ${accountOptionsList(expensePool)}.` };
            }
            resolvedLines.push({
              description: line.description,
              quantity: line.quantity ?? "1",
              unitPrice: line.unitPrice,
              accountId: account.id,
              accountLabel: `${account.code} ${account.name}`,
            });
          }

          const currency = supplier.currency;
          let totals;
          try {
            totals = calculateBillTotals(resolvedLines, currency, new Map());
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "Invalid bill line." };
          }

          const issueDate = parseDateArg(args.issueDate, 0);
          const dueDate = parseDateArg(args.dueDate, 30);

          const previewLines: DraftProposalPreviewLine[] = resolvedLines.map((l, i) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            accountLabel: l.accountLabel,
            amount: totals!.lines[i]!.lineAmount,
          }));

          const proposal = await AIDraftProposalService.create(actor, {
            type: "BILL",
            payload: {
              supplierContactId: supplier.id,
              issueDate: formatDateParam(issueDate),
              dueDate: formatDateParam(dueDate),
              currency,
              apAccountId: apAccount.id,
              memo: args.memo,
              lines: resolvedLines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, accountId: l.accountId })),
            },
            preview: {
              type: "BILL",
              headline: `Draft bill from ${supplier.displayName} for ${totals!.total} ${currency}`,
              counterpartyName: supplier.displayName,
              currency,
              total: totals!.total,
              memo: args.memo,
              lines: previewLines,
            },
            model,
            question,
          });

          return {
            ok: true,
            summary: `I've prepared a draft bill from ${supplier.displayName} for ${totals!.total} ${currency} (due ${formatDateParam(dueDate)}). It has NOT been created yet — show the user the confirmation card so they can review and explicitly confirm it.`,
            citation: { tool: "prepare_draft_bill", description: `Draft bill proposal from ${supplier.displayName}` },
            proposal: { id: proposal.id, preview: proposal.preview },
          };
        }),
    },
    {
      name: "prepare_draft_journal_entry",
      description:
        "Prepare a DRAFT manual journal entry for human review — this NEVER posts anything itself. Lines must balance (total debits = total credits) in the organization's base currency. Use this only for an unusual/manual adjustment the user explicitly asks for — never to record a normal sale or purchase (use prepare_draft_invoice/prepare_draft_bill for those).",
      inputSchema: {
        type: "object",
        properties: {
          postingDate: { type: "string", description: "YYYY-MM-DD, defaults to today." },
          memo: { type: "string" },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                accountName: { type: "string", description: "Exact or partial account code/name." },
                debit: { type: "string", description: "Decimal string. Exactly one of debit/credit per line." },
                credit: { type: "string", description: "Decimal string. Exactly one of debit/credit per line." },
                memo: { type: "string" },
              },
              required: ["accountName"],
            },
          },
        },
        required: ["lines"],
      },
      argsSchema: PrepareJournalEntryArgsSchema,
      permission: "journal:post",
      execute: (actor, rawArgs) =>
        guardedWrite(async () => {
          assertPermission(actor, "journal:post");
          const args = PrepareJournalEntryArgsSchema.parse(rawArgs);
          const accounts = await AccountService.list(actor);
          const activeAccounts = accounts.filter((a) => a.isActive);

          const resolvedLines: { accountId: string; accountLabel: string; currency: string; debit?: string; credit?: string; memo?: string }[] = [];
          let debitTotal = new Decimal(0);
          let creditTotal = new Decimal(0);
          for (const [i, line] of args.lines.entries()) {
            const q = line.accountName.trim().toLowerCase();
            const exact = activeAccounts.filter((a) => a.code.toLowerCase() === q || a.name.toLowerCase() === q);
            const matches = exact.length > 0 ? exact : activeAccounts.filter((a) => a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
            if (matches.length === 0) return { ok: false, error: `Line ${i + 1}: no account matches "${line.accountName}".` };
            if (matches.length > 1) return { ok: false, error: `Line ${i + 1}: "${line.accountName}" matches more than one account (${accountOptionsList(matches)}) — be more specific.` };
            const account = matches[0]!;

            const hasDebit = line.debit && Number(line.debit) > 0;
            const hasCredit = line.credit && Number(line.credit) > 0;
            if (hasDebit === hasCredit) {
              return { ok: false, error: `Line ${i + 1}: exactly one of debit or credit must be a positive amount.` };
            }
            if (hasDebit) debitTotal = debitTotal.plus(new Decimal(line.debit!));
            if (hasCredit) creditTotal = creditTotal.plus(new Decimal(line.credit!));

            resolvedLines.push({
              accountId: account.id,
              accountLabel: `${account.code} ${account.name}`,
              currency: account.currency,
              debit: hasDebit ? line.debit : undefined,
              credit: hasCredit ? line.credit : undefined,
              memo: line.memo,
            });
          }

          if (!debitTotal.equals(creditTotal)) {
            return {
              ok: false,
              error: `This journal entry does not balance: total debits ${debitTotal.toFixed(2)} vs. total credits ${creditTotal.toFixed(2)}. Adjust the lines so they're equal.`,
            };
          }

          const postingDate = parseDateArg(args.postingDate, 0);

          const previewLines: DraftProposalPreviewLine[] = resolvedLines.map((l) => ({
            description: l.memo ?? l.accountLabel,
            debit: l.debit,
            credit: l.credit,
            accountLabel: l.accountLabel,
          }));

          const proposal = await AIDraftProposalService.create(actor, {
            type: "JOURNAL_ENTRY",
            payload: {
              postingDate: formatDateParam(postingDate),
              memo: args.memo,
              sourceType: "MANUAL",
              lines: resolvedLines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo, currency: l.currency })),
            },
            preview: {
              type: "JOURNAL_ENTRY",
              headline: `Draft journal entry for ${debitTotal.toFixed(2)} (posting ${formatDateParam(postingDate)})`,
              currency: resolvedLines[0]!.currency,
              memo: args.memo,
              lines: previewLines,
            },
            model,
            question,
          });

          return {
            ok: true,
            summary: `I've prepared a draft journal entry (balanced at ${debitTotal.toFixed(2)}), posting date ${formatDateParam(postingDate)}. It has NOT been posted or even created yet — show the user the confirmation card so they can review and explicitly confirm it.`,
            citation: { tool: "prepare_draft_journal_entry", description: "Draft journal entry proposal" },
            proposal: { id: proposal.id, preview: proposal.preview },
          };
        }),
    },
  ];
}

/** The permission each write tool's underlying domain-service call enforces — documented for tests/audits, mirroring `controller-tools.ts`. */
export const WRITE_TOOL_PERMISSIONS: Record<string, Permission> = {
  prepare_draft_invoice: "customer_invoice:manage",
  prepare_draft_bill: "supplier_bill:manage",
  prepare_draft_journal_entry: "journal:post",
};
