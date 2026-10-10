import { describe, expect, it } from "vitest";
import {
  calculateDurationHours,
  InvalidTimerRangeError,
  selectUnbilledEntries,
  type UnbilledTimeFilterEntry,
} from "@/domain/projects/time-calculations";

describe("calculateDurationHours", () => {
  it("computes exact hours for a round-number duration", () => {
    expect(calculateDurationHours(new Date("2026-01-01T09:00:00Z"), new Date("2026-01-01T11:00:00Z"))).toBe("2.00");
  });

  it("rounds a fractional duration to 2 decimal places", () => {
    // 1h 30m 36s = 1.51 hours exactly (36s = 0.01h)
    expect(calculateDurationHours(new Date("2026-01-01T09:00:00Z"), new Date("2026-01-01T10:30:36Z"))).toBe("1.51");
  });

  it("rounds a half-way duration to the nearest even cent of an hour (banker's rounding)", () => {
    // 90 seconds = 0.025h exactly — round-half-even rounds the tied value
    // down to 0.02 since 2 is the even neighbor, matching this codebase's
    // money rounding convention (docs/decisions/0003-monetary-precision.md).
    const hours = calculateDurationHours(new Date("2026-01-01T09:00:00Z"), new Date("2026-01-01T09:01:30Z"));
    expect(hours).toBe("0.02");
  });

  it("throws if the stop time is before the start time", () => {
    expect(() =>
      calculateDurationHours(new Date("2026-01-01T11:00:00Z"), new Date("2026-01-01T09:00:00Z")),
    ).toThrow(InvalidTimerRangeError);
  });

  it("throws if the stop time equals the start time", () => {
    const t = new Date("2026-01-01T09:00:00Z");
    expect(() => calculateDurationHours(t, t)).toThrow(InvalidTimerRangeError);
  });
});

describe("selectUnbilledEntries", () => {
  const PROJECT_A = "project-a";
  const PROJECT_B = "project-b";

  function entry(overrides: Partial<UnbilledTimeFilterEntry>): UnbilledTimeFilterEntry {
    return {
      id: "e1",
      projectId: PROJECT_A,
      status: "APPROVED",
      billable: true,
      invoiceId: null,
      entryDate: new Date("2026-02-15"),
      ...overrides,
    };
  }

  it("selects only approved, billable, uninvoiced entries for the given project", () => {
    const entries: UnbilledTimeFilterEntry[] = [
      entry({ id: "ok-1" }),
      entry({ id: "draft", status: "DRAFT" }),
      entry({ id: "submitted", status: "SUBMITTED" }),
      entry({ id: "rejected", status: "REJECTED" }),
      entry({ id: "non-billable", billable: false }),
      entry({ id: "already-invoiced", status: "INVOICED", invoiceId: "inv-1" }),
      entry({ id: "wrong-project", projectId: PROJECT_B }),
      entry({ id: "ok-2" }),
    ];

    const selected = selectUnbilledEntries(entries, { projectId: PROJECT_A });
    expect(selected.map((e) => e.id).sort()).toEqual(["ok-1", "ok-2"]);
  });

  it("respects an inclusive date range", () => {
    const entries: UnbilledTimeFilterEntry[] = [
      entry({ id: "before", entryDate: new Date("2026-01-01") }),
      entry({ id: "in-range", entryDate: new Date("2026-02-15") }),
      entry({ id: "on-boundary-from", entryDate: new Date("2026-02-01") }),
      entry({ id: "on-boundary-to", entryDate: new Date("2026-02-28") }),
      entry({ id: "after", entryDate: new Date("2026-03-01") }),
    ];

    const selected = selectUnbilledEntries(entries, {
      projectId: PROJECT_A,
      from: new Date("2026-02-01"),
      to: new Date("2026-02-28"),
    });
    expect(selected.map((e) => e.id).sort()).toEqual(["in-range", "on-boundary-from", "on-boundary-to"]);
  });

  it("returns nothing already claimed by a previous invoicing run (re-run doesn't double-bill)", () => {
    const entries: UnbilledTimeFilterEntry[] = [entry({ id: "already-billed", status: "INVOICED", invoiceId: "inv-9" })];
    expect(selectUnbilledEntries(entries, { projectId: PROJECT_A })).toHaveLength(0);
  });
});
