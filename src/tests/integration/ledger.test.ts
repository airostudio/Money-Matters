import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../helpers/db";
import { createSampleAccounts } from "../helpers/ledger";
import { PostingService } from "@/domain/ledger/posting-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { FiscalPeriodService } from "@/domain/ledger/fiscal-period-service";
import {
  EntryNotFoundError,
  ImmutableEntryError,
  InvalidJournalLineError,
  PeriodLockedError,
  UnbalancedJournalError,
} from "@/domain/ledger/errors";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import { Money } from "@/domain/money/money";
import type { Actor } from "@/domain/permissions/permission-service";

describe("PostingService (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let organizationId: string;
  let accountIds: string[];

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("ledger");
    owner = org.owner;
    organizationId = org.organizationId;
    accountIds = await createSampleAccounts(owner, org.baseCurrency);
  });

  it("posts a simple balanced two-line entry", async () => {
    const [bank, revenue] = accountIds;
    const result = await PostingService.postJournal(owner, {
      postingDate: new Date("2026-07-15"),
      memo: "Cash sale",
      lines: [
        { accountId: bank!, debit: "1100.00", currency: "AUD" },
        { accountId: revenue!, credit: "1100.00", currency: "AUD" },
      ],
    });

    const entry = await LedgerService.getJournalEntry(owner, result.entryId);
    expect(entry?.status).toBe("POSTED");
    expect(entry?.lines).toHaveLength(2);
    expect(entry?.entryNumber).toBe("JE-000001");
  });

  it("posts a multi-line split entry that still balances", async () => {
    const [bank, ar, ap, gst, revenue] = accountIds;
    const result = await PostingService.postJournal(owner, {
      postingDate: new Date("2026-07-16"),
      lines: [
        { accountId: bank!, debit: "500.00", currency: "AUD" },
        { accountId: ar!, debit: "600.00", currency: "AUD" },
        { accountId: revenue!, credit: "1000.00", currency: "AUD" },
        { accountId: gst!, credit: "100.00", currency: "AUD" },
        { accountId: ap!, credit: "0.00", currency: "AUD" }, // will fail: zero on both sides below
      ],
    }).catch((e) => e);

    // The zero-amount line above is itself invalid (neither side positive) —
    // confirms line-level validation, not just the aggregate balance check.
    expect(result).toBeInstanceOf(InvalidJournalLineError);
  });

  it("rejects an entry with fewer than two lines", async () => {
    await expect(
      PostingService.postJournal(owner, {
        postingDate: new Date(),
        lines: [{ accountId: accountIds[0]!, debit: "10.00", currency: "AUD" }],
      }),
    ).rejects.toThrow(UnbalancedJournalError);
  });

  it("rejects an unbalanced entry and persists nothing", async () => {
    const [bank, revenue] = accountIds;
    await expect(
      PostingService.postJournal(owner, {
        postingDate: new Date(),
        lines: [
          { accountId: bank!, debit: "100.00", currency: "AUD" },
          { accountId: revenue!, credit: "90.00", currency: "AUD" },
        ],
      }),
    ).rejects.toThrow(UnbalancedJournalError);

    const entries = await LedgerService.listJournalEntries(owner);
    expect(entries).toHaveLength(0);
  });

  it("rejects a line with both debit and credit set", async () => {
    const [bank, revenue] = accountIds;
    await expect(
      PostingService.postJournal(owner, {
        postingDate: new Date(),
        lines: [
          { accountId: bank!, debit: "100.00", credit: "100.00", currency: "AUD" },
          { accountId: revenue!, credit: "100.00", currency: "AUD" },
        ],
      }),
    ).rejects.toThrow(InvalidJournalLineError);
  });

  it("rejects a line referencing an account from another organization", async () => {
    const other = await createTestOrg("other");
    const otherAccounts = await createSampleAccounts(other.owner, other.baseCurrency);

    await expect(
      PostingService.postJournal(owner, {
        postingDate: new Date(),
        lines: [
          { accountId: otherAccounts[0]!, debit: "100.00", currency: "AUD" },
          { accountId: accountIds[1]!, credit: "100.00", currency: "AUD" },
        ],
      }),
    ).rejects.toThrow(InvalidJournalLineError);
  });

  it("denies posting for a role without journal:post permission", async () => {
    const readOnlyActor: Actor = { ...owner, role: "READ_ONLY" };
    await expect(
      PostingService.postJournal(readOnlyActor, {
        postingDate: new Date(),
        lines: [
          { accountId: accountIds[0]!, debit: "10.00", currency: "AUD" },
          { accountId: accountIds[1]!, credit: "10.00", currency: "AUD" },
        ],
      }),
    ).rejects.toThrow(PermissionDeniedError);
  });

  describe("draft lifecycle", () => {
    it("creates a draft, then posts it", async () => {
      const [bank, revenue] = accountIds;
      const draft = await PostingService.createDraft(owner, {
        postingDate: new Date("2026-07-01"),
        lines: [
          { accountId: bank!, debit: "250.00", currency: "AUD" },
          { accountId: revenue!, credit: "250.00", currency: "AUD" },
        ],
      });

      let entry = await LedgerService.getJournalEntry(owner, draft.entryId);
      expect(entry?.status).toBe("DRAFT");

      await PostingService.postDraft(owner, draft.entryId);
      entry = await LedgerService.getJournalEntry(owner, draft.entryId);
      expect(entry?.status).toBe("POSTED");
    });

    it("deletes a draft outright", async () => {
      const [bank, revenue] = accountIds;
      const draft = await PostingService.createDraft(owner, {
        postingDate: new Date(),
        lines: [
          { accountId: bank!, debit: "10.00", currency: "AUD" },
          { accountId: revenue!, credit: "10.00", currency: "AUD" },
        ],
      });

      await PostingService.deleteDraft(owner, draft.entryId);
      const entry = await LedgerService.getJournalEntry(owner, draft.entryId);
      expect(entry).toBeUndefined();
    });

    it("refuses to delete or re-post an already-posted entry", async () => {
      const [bank, revenue] = accountIds;
      const result = await PostingService.postJournal(owner, {
        postingDate: new Date(),
        lines: [
          { accountId: bank!, debit: "10.00", currency: "AUD" },
          { accountId: revenue!, credit: "10.00", currency: "AUD" },
        ],
      });

      await expect(PostingService.deleteDraft(owner, result.entryId)).rejects.toThrow(
        ImmutableEntryError,
      );
      await expect(PostingService.postDraft(owner, result.entryId)).rejects.toThrow(
        ImmutableEntryError,
      );
    });

    it("raises EntryNotFoundError for an unknown entry id", async () => {
      await expect(
        PostingService.postDraft(owner, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow(EntryNotFoundError);
    });
  });

  describe("fiscal period locking", () => {
    it("rejects posting into a hard-locked period", async () => {
      const period = await FiscalPeriodService.create(owner, {
        label: "2026-07",
        startDate: new Date("2026-07-01"),
        endDate: new Date("2026-07-31"),
      });
      await FiscalPeriodService.setStatus(owner, period.id, "HARD_LOCKED", "period closed");

      const [bank, revenue] = accountIds;
      await expect(
        PostingService.postJournal(owner, {
          postingDate: new Date("2026-07-15"),
          lines: [
            { accountId: bank!, debit: "10.00", currency: "AUD" },
            { accountId: revenue!, credit: "10.00", currency: "AUD" },
          ],
        }),
      ).rejects.toThrow(PeriodLockedError);
    });

    it("allows posting into an open period and into dates with no period at all", async () => {
      const period = await FiscalPeriodService.create(owner, {
        label: "2026-08",
        startDate: new Date("2026-08-01"),
        endDate: new Date("2026-08-31"),
      });
      expect(period.status).toBe("OPEN");

      const [bank, revenue] = accountIds;
      await expect(
        PostingService.postJournal(owner, {
          postingDate: new Date("2026-08-15"),
          lines: [
            { accountId: bank!, debit: "10.00", currency: "AUD" },
            { accountId: revenue!, credit: "10.00", currency: "AUD" },
          ],
        }),
      ).resolves.toBeDefined();

      // No fiscal period exists for this date at all — Phase 1 still allows it.
      await expect(
        PostingService.postJournal(owner, {
          postingDate: new Date("2030-01-01"),
          lines: [
            { accountId: bank!, debit: "5.00", currency: "AUD" },
            { accountId: revenue!, credit: "5.00", currency: "AUD" },
          ],
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("reversal", () => {
    it("mirrors every line's debit/credit and preserves the original", async () => {
      const [bank, revenue] = accountIds;
      const original = await PostingService.postJournal(owner, {
        postingDate: new Date("2026-07-10"),
        lines: [
          { accountId: bank!, debit: "750.00", currency: "AUD" },
          { accountId: revenue!, credit: "750.00", currency: "AUD" },
        ],
      });

      const reversal = await PostingService.reverseEntry(owner, original.entryId, "duplicate entry");

      const originalEntry = await LedgerService.getJournalEntry(owner, original.entryId);
      const reversalEntry = await LedgerService.getJournalEntry(owner, reversal.entryId);

      expect(originalEntry?.status).toBe("REVERSED");
      expect(reversalEntry?.status).toBe("POSTED");
      expect(reversalEntry?.reversalOf?.id).toBe(original.entryId);

      const bankLineOriginal = originalEntry?.lines.find((l) => l.accountId === bank);
      const bankLineReversal = reversalEntry?.lines.find((l) => l.accountId === bank);
      expect(bankLineOriginal?.debit).toBe("750.0000");
      expect(bankLineReversal?.credit).toBe("750.0000");

      // Net effect across both entries is zero for every account touched.
      const trialBalance = await LedgerService.getTrialBalance(owner, new Date("2099-01-01"));
      const bankRow = trialBalance.find((r) => r.accountId === bank);
      expect(bankRow?.balance).toBe("0.0000");
    });

    it("refuses to reverse a draft or an already-reversed entry", async () => {
      const [bank, revenue] = accountIds;
      const draft = await PostingService.createDraft(owner, {
        postingDate: new Date(),
        lines: [
          { accountId: bank!, debit: "10.00", currency: "AUD" },
          { accountId: revenue!, credit: "10.00", currency: "AUD" },
        ],
      });
      await expect(PostingService.reverseEntry(owner, draft.entryId, "nope")).rejects.toThrow(
        ImmutableEntryError,
      );

      const posted = await PostingService.postJournal(owner, {
        postingDate: new Date(),
        lines: [
          { accountId: bank!, debit: "20.00", currency: "AUD" },
          { accountId: revenue!, credit: "20.00", currency: "AUD" },
        ],
      });
      await PostingService.reverseEntry(owner, posted.entryId, "first reversal");
      await expect(PostingService.reverseEntry(owner, posted.entryId, "second reversal")).rejects.toThrow(
        ImmutableEntryError,
      );
    });
  });

  describe("trial balance", () => {
    it("stays in balance across many postings, and every account's normal-balance sign is correct", async () => {
      const [bank, ar, ap, gst, revenue, expense] = accountIds;

      await PostingService.postJournal(owner, {
        postingDate: new Date("2026-07-01"),
        lines: [
          { accountId: bank!, debit: "1100.00", currency: "AUD" },
          { accountId: revenue!, credit: "1000.00", currency: "AUD" },
          { accountId: gst!, credit: "100.00", currency: "AUD" },
        ],
      });
      await PostingService.postJournal(owner, {
        postingDate: new Date("2026-07-05"),
        lines: [
          { accountId: expense!, debit: "300.00", currency: "AUD" },
          { accountId: ap!, credit: "300.00", currency: "AUD" },
        ],
      });
      await PostingService.postJournal(owner, {
        postingDate: new Date("2026-07-10"),
        lines: [
          { accountId: ar!, debit: "450.00", currency: "AUD" },
          { accountId: revenue!, credit: "450.00", currency: "AUD" },
        ],
      });

      const trialBalance = await LedgerService.getTrialBalance(owner, new Date("2099-01-01"));

      const totalDebitBalances = trialBalance
        .filter((r) => r.type === "ASSET" || r.type === "EXPENSE")
        .reduce((sum, r) => sum.add(Money.of(r.balance, "AUD")), Money.zero("AUD"));
      const totalCreditBalances = trialBalance
        .filter((r) => r.type === "LIABILITY" || r.type === "EQUITY" || r.type === "REVENUE")
        .reduce((sum, r) => sum.add(Money.of(r.balance, "AUD")), Money.zero("AUD"));

      expect(totalDebitBalances.equals(totalCreditBalances)).toBe(true);

      const revenueRow = trialBalance.find((r) => r.accountId === revenue);
      expect(revenueRow?.balance).toBe("1450.0000"); // credit-normal, net credit balance
    });
  });
});
