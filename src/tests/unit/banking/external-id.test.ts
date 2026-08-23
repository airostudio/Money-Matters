import { describe, expect, it } from "vitest";
import { assignExternalIds } from "@/domain/banking/external-id";
import type { ParsedStatementRow } from "@/domain/banking/types";

function row(overrides: Partial<ParsedStatementRow> = {}): ParsedStatementRow {
  return {
    postedDate: new Date("2026-01-15T00:00:00Z"),
    description: "Coffee",
    amount: "-5.0000",
    raw: {},
    ...overrides,
  };
}

describe("assignExternalIds", () => {
  it("leaves an existing externalId (e.g. OFX FITID) untouched", () => {
    const [result] = assignExternalIds([row({ externalId: "fitid-1" })]);
    expect(result?.externalId).toBe("fitid-1");
  });

  it("is deterministic: the same content produces the same id on re-import", () => {
    const [first] = assignExternalIds([row()]);
    const [second] = assignExternalIds([row()]);
    expect(first?.externalId).toBe(second?.externalId);
  });

  it("gives two distinct identical-looking transactions distinct ids", () => {
    const [a, b] = assignExternalIds([row(), row()]);
    expect(a?.externalId).not.toBe(b?.externalId);
  });

  it("assigns the same nth-occurrence id across two separate parses of the same content", () => {
    const firstPass = assignExternalIds([row(), row(), row()]);
    const secondPass = assignExternalIds([row(), row(), row()]);
    expect(firstPass.map((r) => r.externalId)).toEqual(secondPass.map((r) => r.externalId));
  });

  it("gives rows with different amounts distinct ids even on the same day/description", () => {
    const [a, b] = assignExternalIds([row({ amount: "-5.0000" }), row({ amount: "-6.0000" })]);
    expect(a?.externalId).not.toBe(b?.externalId);
  });
});
