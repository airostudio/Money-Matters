import { describe, expect, it } from "vitest";
import { InvalidDeadlineRuleError, nextOccurrences, STARTER_TEMPLATES, validateRule, type DeadlineRule } from "@/domain/practice/tax-calendar";

const quarterly: DeadlineRule = { frequency: "QUARTERLY", periodEndMonth: 6, dueMonthsAfter: 1, dueDay: 28 };

describe("tax calendar — next occurrences of a rule the PRACTICE entered", () => {
  it("quarterly rule: quarters end every third month from the period-end month; the deadline is dueDay of the month after", () => {
    const occ = nextOccurrences(quarterly, "2026-10-05", 4);
    expect(occ).toEqual([
      { periodEnd: "2026-09-30", dueDate: "2026-10-28" },
      { periodEnd: "2026-12-31", dueDate: "2027-01-28" },
      { periodEnd: "2027-03-31", dueDate: "2027-04-28" },
      { periodEnd: "2027-06-30", dueDate: "2027-07-28" },
    ]);
  });

  it("a deadline exactly on the from date is included; one day earlier is not", () => {
    expect(nextOccurrences(quarterly, "2026-10-28", 1)[0]!.dueDate).toBe("2026-10-28");
    expect(nextOccurrences(quarterly, "2026-10-29", 1)[0]!.dueDate).toBe("2027-01-28");
  });

  it("a period that ended before `from` but whose deadline is still ahead is generated", () => {
    // September quarter ended 30 Sep; on 5 Oct its deadline (28 Oct) is still to come.
    expect(nextOccurrences(quarterly, "2026-10-05", 1)[0]!.periodEnd).toBe("2026-09-30");
  });

  it("the quarter alignment follows periodEndMonth (a rule anchored on March gives Mar/Jun/Sep/Dec period ends)", () => {
    const occ = nextOccurrences({ ...quarterly, periodEndMonth: 3 }, "2026-01-01", 4).map((o) => o.periodEnd);
    // (the December period's deadline, 28 Jan, is still ahead of 1 Jan, so it is included)
    expect(occ).toEqual(["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"]);
    const occ2 = nextOccurrences({ ...quarterly, periodEndMonth: 1 }, "2026-01-01", 2).map((o) => o.periodEnd);
    expect(occ2).toEqual(["2026-01-31", "2026-04-30"]);
  });

  it("monthly rule: every month end, deadline in the following month", () => {
    const occ = nextOccurrences({ frequency: "MONTHLY", periodEndMonth: 1, dueMonthsAfter: 1, dueDay: 21 }, "2026-11-15", 3);
    expect(occ).toEqual([
      { periodEnd: "2026-10-31", dueDate: "2026-11-21" },
      { periodEnd: "2026-11-30", dueDate: "2026-12-21" },
      { periodEnd: "2026-12-31", dueDate: "2027-01-21" },
    ]);
  });

  it("annual rule with a deadline several months after year end", () => {
    const occ = nextOccurrences({ frequency: "ANNUAL", periodEndMonth: 6, dueMonthsAfter: 4, dueDay: 31 }, "2026-10-05", 2);
    expect(occ).toEqual([
      { periodEnd: "2026-06-30", dueDate: "2026-10-31" },
      { periodEnd: "2027-06-30", dueDate: "2027-10-31" },
    ]);
  });

  it("the due day is clamped to the length of the month (31 in February is the 28th, or the 29th in a leap year)", () => {
    const feb = { frequency: "ANNUAL" as const, periodEndMonth: 1, dueMonthsAfter: 1, dueDay: 31 };
    expect(nextOccurrences(feb, "2027-01-01", 1)[0]!.dueDate).toBe("2027-02-28");
    expect(nextOccurrences(feb, "2028-01-01", 1)[0]!.dueDate).toBe("2028-02-29");
  });

  it("zero months after: the deadline is in the period-end month itself", () => {
    const occ = nextOccurrences({ frequency: "MONTHLY", periodEndMonth: 1, dueMonthsAfter: 0, dueDay: 31 }, "2026-11-01", 1);
    expect(occ[0]).toEqual({ periodEnd: "2026-11-30", dueDate: "2026-11-30" });
  });

  it("rolls across year boundaries and returns exactly `count` in ascending order", () => {
    const occ = nextOccurrences({ frequency: "MONTHLY", periodEndMonth: 1, dueMonthsAfter: 2, dueDay: 15 }, "2026-12-20", 5);
    expect(occ.length).toBe(5);
    expect(occ.map((o) => o.dueDate)).toEqual([...occ.map((o) => o.dueDate)].sort());
    expect(occ[0]).toEqual({ periodEnd: "2026-11-30", dueDate: "2027-01-15" });
  });

  it("rejects an invalid rule or arguments", () => {
    expect(() => validateRule({ ...quarterly, dueDay: 0 })).toThrow(InvalidDeadlineRuleError);
    expect(() => validateRule({ ...quarterly, dueDay: 32 })).toThrow(InvalidDeadlineRuleError);
    expect(() => validateRule({ ...quarterly, periodEndMonth: 13 })).toThrow(InvalidDeadlineRuleError);
    expect(() => validateRule({ ...quarterly, dueMonthsAfter: 13 })).toThrow(InvalidDeadlineRuleError);
    expect(() => validateRule({ ...quarterly, frequency: "WEEKLY" as never })).toThrow(InvalidDeadlineRuleError);
    expect(() => nextOccurrences(quarterly, "05/10/2026", 1)).toThrow(InvalidDeadlineRuleError);
    expect(() => nextOccurrences(quarterly, "2026-10-05", 0)).toThrow(InvalidDeadlineRuleError);
    expect(() => nextOccurrences(quarterly, "2026-10-05", 25)).toThrow(InvalidDeadlineRuleError);
  });

  it("starter templates are valid rules and are all labelled as suggestions to verify (never presented as authoritative)", () => {
    for (const t of STARTER_TEMPLATES) {
      expect(() => validateRule(t.rule)).not.toThrow();
      expect(t.name.toLowerCase()).toMatch(/suggestion/);
    }
  });
});
