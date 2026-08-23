import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSampleAccounts } from "../../helpers/ledger";
import { PostingService } from "@/domain/ledger/posting-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { Money } from "@/domain/money/money";
import type { Actor } from "@/domain/permissions/permission-service";
import type { JournalEntryDraft, JournalLineDraft } from "@/domain/ledger/types";

const CURRENCY = "AUD";

function validJournalArbitrary(accountIds: string[]) {
  return fc
    .record({
      totalCents: fc.integer({ min: 100, max: 999_999 }),
      numDebitLines: fc.integer({ min: 1, max: 4 }),
      numCreditLines: fc.integer({ min: 1, max: 4 }),
      debitAccountIdxs: fc.array(fc.integer({ min: 0, max: accountIds.length - 1 }), {
        minLength: 4,
        maxLength: 4,
      }),
      creditAccountIdxs: fc.array(fc.integer({ min: 0, max: accountIds.length - 1 }), {
        minLength: 4,
        maxLength: 4,
      }),
    })
    .map(({ totalCents, numDebitLines, numCreditLines, debitAccountIdxs, creditAccountIdxs }) => {
      const total = Money.of((totalCents / 100).toFixed(2), CURRENCY);
      const debitShares = total.allocate(Array.from({ length: numDebitLines }, () => 1));
      const creditShares = total.allocate(Array.from({ length: numCreditLines }, () => 1));

      const lines: JournalLineDraft[] = [
        ...debitShares.map((share, i) => ({
          accountId: accountIds[debitAccountIdxs[i % debitAccountIdxs.length]!]!,
          debit: share.toString(),
          currency: CURRENCY,
        })),
        ...creditShares.map((share, i) => ({
          accountId: accountIds[creditAccountIdxs[i % creditAccountIdxs.length]!]!,
          credit: share.toString(),
          currency: CURRENCY,
        })),
      ];

      return {
        postingDate: new Date("2026-07-20"),
        memo: "property test: valid journal",
        lines,
      } satisfies JournalEntryDraft;
    });
}

/** Takes a valid (balanced) journal and perturbs exactly one line so it can no longer balance. */
function unbalancedJournalArbitrary(accountIds: string[]) {
  return fc
    .tuple(validJournalArbitrary(accountIds), fc.integer({ min: 1, max: 5000 }), fc.nat())
    .map(([draft, deltaCents, seed]) => {
      const idx = seed % draft.lines.length;
      const delta = Money.of((deltaCents / 100).toFixed(2), CURRENCY);
      const lines = draft.lines.map((line, i) => {
        if (i !== idx) return line;
        if (line.debit) {
          return { ...line, debit: Money.of(line.debit, CURRENCY).add(delta).toString() };
        }
        return { ...line, credit: Money.of(line.credit!, CURRENCY).add(delta).toString() };
      });
      return { ...draft, lines } satisfies JournalEntryDraft;
    });
}

describe("Ledger balance invariant (property-based)", () => {
  let owner: Actor;
  let accountIds: string[];

  beforeAll(async () => {
    await resetDatabase();
    const org = await createTestOrg("prop-ledger");
    owner = org.owner;
    accountIds = await createSampleAccounts(owner, org.baseCurrency);
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("every accepted journal has SUM(debit) === SUM(credit) once persisted", async () => {
    await fc.assert(
      fc.asyncProperty(validJournalArbitrary(accountIds), async (draft) => {
        const result = await PostingService.postJournal(owner, draft);
        const entry = await LedgerService.getJournalEntry(owner, result.entryId);
        if (!entry) throw new Error("Posted entry vanished.");

        const totalDebit = entry.lines.reduce(
          (sum, l) => sum.add(Money.of(l.baseDebit, "AUD")),
          Money.zero("AUD"),
        );
        const totalCredit = entry.lines.reduce(
          (sum, l) => sum.add(Money.of(l.baseCredit, "AUD")),
          Money.zero("AUD"),
        );
        return totalDebit.equals(totalCredit);
      }),
      { numRuns: 25 },
    );
  });

  it("every unbalanced journal is rejected and persists no rows", async () => {
    await fc.assert(
      fc.asyncProperty(unbalancedJournalArbitrary(accountIds), async (draft) => {
        const before = await LedgerService.listJournalEntries(owner, { limit: 100_000 });

        let threw = false;
        try {
          await PostingService.postJournal(owner, draft);
        } catch {
          threw = true;
        }

        const after = await LedgerService.listJournalEntries(owner, { limit: 100_000 });
        return threw && after.length === before.length;
      }),
      { numRuns: 25 },
    );
  });
});
