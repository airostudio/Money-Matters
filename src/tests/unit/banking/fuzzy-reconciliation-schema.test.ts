import { describe, expect, it } from "vitest";
import { FuzzySuggestionItemSchema, FuzzySuggestionsSchema } from "@/domain/banking/fuzzy-reconciliation-service";

const LINE_ID = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_ID = "22222222-2222-2222-2222-222222222222";

describe("FuzzySuggestionItemSchema", () => {
  it("accepts a journal-line suggestion", () => {
    const result = FuzzySuggestionItemSchema.safeParse({
      candidateJournalLineId: LINE_ID,
      confidence: 0.7,
      reasoning: "Amount is within 5% and posted 3 days later.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an account-categorization suggestion", () => {
    const result = FuzzySuggestionItemSchema.safeParse({
      candidateAccountId: ACCOUNT_ID,
      confidence: 0.4,
      reasoning: "Description mentions fuel, matches this expense account's usual pattern.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a suggestion with BOTH a line id and an account id", () => {
    const result = FuzzySuggestionItemSchema.safeParse({
      candidateJournalLineId: LINE_ID,
      candidateAccountId: ACCOUNT_ID,
      confidence: 0.5,
      reasoning: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a suggestion with NEITHER a line id nor an account id", () => {
    const result = FuzzySuggestionItemSchema.safeParse({ confidence: 0.5, reasoning: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid id", () => {
    const result = FuzzySuggestionItemSchema.safeParse({
      candidateJournalLineId: "not-a-uuid",
      confidence: 0.5,
      reasoning: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a confidence outside [0,1]", () => {
    const result = FuzzySuggestionItemSchema.safeParse({
      candidateJournalLineId: LINE_ID,
      confidence: 1.1,
      reasoning: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("FuzzySuggestionsSchema", () => {
  it("caps the list at 5 suggestions", () => {
    const suggestions = Array.from({ length: 6 }, () => ({
      candidateJournalLineId: LINE_ID,
      confidence: 0.5,
      reasoning: "x",
    }));
    expect(FuzzySuggestionsSchema.safeParse({ suggestions }).success).toBe(false);
  });

  it("accepts an empty list — the model saying nothing plausibly matches", () => {
    expect(FuzzySuggestionsSchema.safeParse({ suggestions: [] }).success).toBe(true);
  });
});
