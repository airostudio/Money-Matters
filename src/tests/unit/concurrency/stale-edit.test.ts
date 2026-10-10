import { describe, expect, it } from "vitest";
import {
  StaleEditError,
  editVersionOf,
  formatChangedAt,
  isStaleEdit,
  nextUpdatedAt,
} from "@/domain/concurrency/stale-edit";

describe("optimistic-concurrency helpers", () => {
  const t0 = new Date("2026-10-05T14:03:09.123Z");

  it("a version round-trips and matches the same instant", () => {
    expect(isStaleEdit(editVersionOf(t0), t0)).toBe(false);
    // Postgres holds microseconds; JS Date truncates to ms on both sides.
    expect(isStaleEdit(editVersionOf(t0), new Date(t0.getTime()))).toBe(false);
  });

  it("is stale when the record moved on", () => {
    expect(isStaleEdit(editVersionOf(t0), new Date(t0.getTime() + 1))).toBe(true);
  });

  it("only a missing expectation skips the check; an empty or garbage one is stale", () => {
    expect(isStaleEdit(undefined, t0)).toBe(false);
    expect(isStaleEdit("", t0)).toBe(true);
    expect(isStaleEdit("not a date", t0)).toBe(true);
  });

  it("nextUpdatedAt is strictly after the previous value even within the same millisecond", () => {
    expect(nextUpdatedAt(t0, t0).getTime()).toBe(t0.getTime() + 1);
    const later = new Date(t0.getTime() + 5000);
    expect(nextUpdatedAt(t0, later).getTime()).toBe(later.getTime());
    // A clock that went backwards still moves forward.
    expect(nextUpdatedAt(t0, new Date(t0.getTime() - 10_000)).getTime()).toBe(t0.getTime() + 1);
  });

  it("StaleEditError names who, when and what to do", () => {
    const err = new StaleEditError("invoice", "INV-0007", "Priya", t0);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StaleEditError");
    expect(err.message).toContain("INV-0007");
    expect(err.message).toContain("Priya");
    expect(err.message).toContain(formatChangedAt(t0));
    expect(err.message).toContain("2026-10-05 14:03 UTC");
    expect(err.message).toMatch(/Reload the page/);
    expect(err.message).toMatch(/not saved/);
    expect(new StaleEditError("bill", "BILL-1", null, t0).message).toContain("someone else");
  });
});
