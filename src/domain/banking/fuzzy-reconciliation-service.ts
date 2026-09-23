import "server-only";
import Decimal from "decimal.js";
import { z } from "zod";
import { and, eq, gte, lte, ne, notInArray, sql } from "drizzle-orm";
import { accounts, bankAccounts, bankTransactions, journalEntries, journalLines } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import type { MatchCandidate } from "./types";
import { BankTransactionNotFoundError } from "./errors";

/** Wider than the deterministic pass's ±10 days — this is a lower-confidence, second-chance layer. */
const FUZZY_MATCH_WINDOW_DAYS = 30;
/** Near-amount tolerance for a fuzzy candidate journal line: ±20%. */
const FUZZY_AMOUNT_TOLERANCE = 0.2;
const MAX_LINE_CANDIDATES = 15;
const MAX_ACCOUNT_CANDIDATES = 25;

/**
 * A fuzzy suggestion is EITHER an existing journal line (a near-amount,
 * date-proximate posted line the deterministic pass didn't consider an
 * exact match) OR a GL account to categorize a brand-new transaction
 * against — never both. Re-validated with zod exactly like every other AI
 * response in this codebase (see docs/ai-agents.md); the ids themselves are
 * checked against the actual candidate pool handed to the model below,
 * since an id an AI response merely claims is never trusted on its own —
 * only a member of the pool we ourselves queried can ever be returned.
 */
const FuzzySuggestionItemSchema = z
  .object({
    candidateJournalLineId: z.string().uuid().optional(),
    candidateAccountId: z.string().uuid().optional(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1).max(1000),
  })
  .refine((v) => Boolean(v.candidateJournalLineId) !== Boolean(v.candidateAccountId), {
    message: "exactly one of candidateJournalLineId or candidateAccountId must be set",
  });

const FuzzySuggestionsSchema = z.object({
  suggestions: z.array(FuzzySuggestionItemSchema).max(5),
});

export interface FuzzyMatchCandidate extends Omit<MatchCandidate, "journalLineId"> {
  journalLineId?: string;
  /** Set instead of journalLineId when the AI suggests a GL category rather than an existing journal line. */
  categorizedAccountId?: string;
  categorizedAccountName?: string;
  source: "AI";
  model: string;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const SUGGEST_TOOL_NAME = "suggest_bank_matches";

interface LinePool {
  lineId: string;
  entryId: string;
  entryNumber: string;
  postingDate: Date;
  memo: string | null;
  amount: string;
}

interface AccountPool {
  accountId: string;
  code: string;
  name: string;
}

async function loadFuzzyLineCandidates(
  tx: TenantDb,
  organizationId: string,
  bankAccountGlAccountId: string,
  isInflow: boolean,
  postedDate: Date,
  absAmount: Decimal,
): Promise<LinePool[]> {
  const windowStart = new Date(postedDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - FUZZY_MATCH_WINDOW_DAYS);
  const windowEnd = new Date(postedDate);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + FUZZY_MATCH_WINDOW_DAYS);

  const minAmount = absAmount.times(1 - FUZZY_AMOUNT_TOLERANCE).toFixed(4);
  const maxAmount = absAmount.times(1 + FUZZY_AMOUNT_TOLERANCE).toFixed(4);

  const alreadyMatched = await tx
    .select({ id: bankTransactions.matchedJournalLineId })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.organizationId, organizationId),
        sql`${bankTransactions.matchedJournalLineId} IS NOT NULL`,
      ),
    );
  const matchedLineIds = alreadyMatched.map((r) => r.id!).filter(Boolean);

  const sideColumn = isInflow ? journalLines.debit : journalLines.credit;

  const rows = await tx
    .select({
      lineId: journalLines.id,
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      postingDate: journalEntries.postingDate,
      memo: journalEntries.memo,
      amount: sideColumn,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .where(
      and(
        eq(journalLines.organizationId, organizationId),
        eq(journalLines.accountId, bankAccountGlAccountId),
        eq(journalEntries.status, "POSTED"),
        gte(sideColumn, minAmount),
        lte(sideColumn, maxAmount),
        ne(sideColumn, "0.0000"),
        gte(journalEntries.postingDate, windowStart),
        lte(journalEntries.postingDate, windowEnd),
        matchedLineIds.length > 0 ? notInArray(journalLines.id, matchedLineIds) : undefined,
      ),
    )
    .limit(MAX_LINE_CANDIDATES);

  return rows.map((r) => ({ ...r, postingDate: new Date(r.postingDate) }));
}

async function loadFuzzyAccountCandidates(
  tx: TenantDb,
  organizationId: string,
  excludeAccountId: string,
): Promise<AccountPool[]> {
  const rows = await tx
    .select({ accountId: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.isActive, true),
        eq(accounts.isControlAccount, false),
        ne(accounts.id, excludeAccountId),
      ),
    )
    .orderBy(accounts.code)
    .limit(MAX_ACCOUNT_CANDIDATES);
  return rows;
}

async function callAiForSuggestions(
  transactionDescription: string,
  transactionAmount: string,
  transactionCurrency: string,
  postedDate: Date,
  linePool: LinePool[],
  accountPool: AccountPool[],
): Promise<z.infer<typeof FuzzySuggestionsSchema>["suggestions"]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  if (linePool.length === 0 && accountPool.length === 0) return [];

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const model = process.env.ANTHROPIC_RECONCILIATION_MODEL || DEFAULT_MODEL;
    const client = new Anthropic({ apiKey, timeout: 15_000 });

    const lineDescriptions = linePool
      .map(
        (l) =>
          `- id=${l.lineId} entry=${l.entryNumber} date=${l.postingDate.toISOString().slice(0, 10)} amount=${l.amount} memo="${l.memo ?? ""}"`,
      )
      .join("\n");
    const accountDescriptions = accountPool.map((a) => `- id=${a.accountId} ${a.code} ${a.name}`).join("\n");

    const message = await client.messages.create({
      model,
      max_tokens: 1024,
      system:
        "You suggest bank reconciliation matches for a transaction that has no exact-amount candidate. " +
        "You may ONLY reference ids from the candidate lists given to you — never invent an id. Each " +
        "suggestion is either an existing journal line id (a near-amount, plausible match) or a GL " +
        "account id (a plausible category for a brand-new transaction) — never both on one suggestion. " +
        "Return at most 5 suggestions, ranked most confident first. If nothing plausibly matches, return " +
        "an empty list. You only ever call the suggest_bank_matches tool.",
      messages: [
        {
          role: "user",
          content:
            `Bank transaction: "${transactionDescription}", amount ${transactionAmount} ${transactionCurrency}, posted ${postedDate.toISOString().slice(0, 10)}.\n\n` +
            `Candidate journal lines (near amount, ±20%, within 30 days):\n${lineDescriptions || "(none)"}\n\n` +
            `Candidate GL accounts to categorize against instead:\n${accountDescriptions || "(none)"}`,
        },
      ],
      tools: [
        {
          name: SUGGEST_TOOL_NAME,
          description: "Report up to 5 ranked reconciliation suggestions.",
          input_schema: {
            type: "object",
            properties: {
              suggestions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    candidateJournalLineId: { type: "string" },
                    candidateAccountId: { type: "string" },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    reasoning: { type: "string" },
                  },
                  required: ["confidence", "reasoning"],
                },
              },
            },
            required: ["suggestions"],
          },
        },
      ],
      tool_choice: { type: "tool", name: SUGGEST_TOOL_NAME },
    });

    const toolUse = message.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
    );
    if (!toolUse) return [];

    const parsed = FuzzySuggestionsSchema.safeParse(toolUse.input);
    if (!parsed.success) return [];

    // Never trust an id merely because the model returned it — only ids we
    // ourselves put in the candidate pool are ever surfaced.
    const validLineIds = new Set(linePool.map((l) => l.lineId));
    const validAccountIds = new Set(accountPool.map((a) => a.accountId));
    return parsed.data.suggestions.filter((s) =>
      s.candidateJournalLineId ? validLineIds.has(s.candidateJournalLineId) : validAccountIds.has(s.candidateAccountId!),
    );
  } catch {
    // Never surface the raw error — the caller shows only deterministic
    // candidates with no AI section, exactly like the onboarding wizard's
    // fallback UX. See docs/ai-agents.md.
    return [];
  }
}

export const FuzzyReconciliationService = {
  /**
   * User-triggered ("Get AI suggestions") — never automatic. Widens the
   * deterministic pass's exact-amount/±10-day window to a near-amount
   * (±20%) / ±30-day pool of journal lines, plus a list of active GL
   * accounts, and asks Claude to rank plausible matches with a
   * plain-language reason. This NEVER posts or confirms anything by
   * itself — every result is surfaced the same way a deterministic
   * candidate is, through the existing `confirmMatch`/
   * `createJournalFromTransaction` paths, so a human always makes the
   * final call. Returns an empty array (never an error) when
   * `ANTHROPIC_API_KEY` is unset, the call fails/times out, or the response
   * fails schema validation — see docs/ai-agents.md.
   */
  async suggestMatches(actor: Actor, bankTransactionId: string): Promise<FuzzyMatchCandidate[]> {
    assertPermission(actor, "bank_transaction:ai_suggest");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ transaction: bankTransactions, bankAccount: bankAccounts })
        .from(bankTransactions)
        .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
        .where(and(eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.organizationId, actor.organizationId)));
      if (!row) throw new BankTransactionNotFoundError(bankTransactionId);
      const { transaction, bankAccount } = row;

      const amount = new Decimal(transaction.amount);
      const isInflow = amount.isPositive();
      const absAmount = amount.abs();

      const [linePool, accountPool] = await Promise.all([
        loadFuzzyLineCandidates(tx, actor.organizationId, bankAccount.glAccountId, isInflow, transaction.postedDate, absAmount),
        loadFuzzyAccountCandidates(tx, actor.organizationId, bankAccount.glAccountId),
      ]);

      const suggestions = await callAiForSuggestions(
        transaction.description,
        absAmount.toFixed(4),
        bankAccount.currency,
        transaction.postedDate,
        linePool,
        accountPool,
      );

      const model = process.env.ANTHROPIC_RECONCILIATION_MODEL || DEFAULT_MODEL;
      const lineById = new Map(linePool.map((l) => [l.lineId, l]));
      const accountById = new Map(accountPool.map((a) => [a.accountId, a]));

      return suggestions
        .map((s): FuzzyMatchCandidate | null => {
          if (s.candidateJournalLineId) {
            const line = lineById.get(s.candidateJournalLineId);
            if (!line) return null;
            return {
              journalLineId: line.lineId,
              journalEntryId: line.entryId,
              entryNumber: line.entryNumber,
              postingDate: line.postingDate,
              memo: line.memo,
              amount: line.amount,
              confidence: s.confidence,
              explanation: s.reasoning,
              source: "AI",
              model,
            };
          }
          const account = accountById.get(s.candidateAccountId!);
          if (!account) return null;
          return {
            journalEntryId: "",
            entryNumber: "",
            postingDate: transaction.postedDate,
            memo: null,
            amount: absAmount.toFixed(4),
            categorizedAccountId: account.accountId,
            categorizedAccountName: `${account.code} ${account.name}`,
            confidence: s.confidence,
            explanation: s.reasoning,
            source: "AI",
            model,
          };
        })
        .filter((s): s is FuzzyMatchCandidate => s !== null)
        .sort((a, b) => b.confidence - a.confidence);
    });
  },
};
