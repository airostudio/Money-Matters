import { describe, expect, it } from "vitest";
import { calculateCollectionPriorityScore } from "@/domain/sales/collection-priority";

describe("calculateCollectionPriorityScore", () => {
  it("scores a fresh, small, on-time-paying customer's invoice low", () => {
    const score = calculateCollectionPriorityScore({
      outstandingAmount: "50.00",
      daysPastDue: 1,
      customerAvgDaysLate: -5,
    });
    expect(score).toBeLessThan(10);
  });

  it("scores a large, very overdue invoice from a chronically-late customer high", () => {
    const score = calculateCollectionPriorityScore({
      outstandingAmount: "20000.00",
      daysPastDue: 120,
      customerAvgDaysLate: 90,
    });
    expect(score).toBe(100);
  });

  it("weighs days overdue more heavily than outstanding amount", () => {
    const highDays = calculateCollectionPriorityScore({
      outstandingAmount: "100.00",
      daysPastDue: 90,
      customerAvgDaysLate: 0,
    });
    const highAmount = calculateCollectionPriorityScore({
      outstandingAmount: "10000.00",
      daysPastDue: 1,
      customerAvgDaysLate: 0,
    });
    expect(highDays).toBeGreaterThan(highAmount);
  });

  it("treats an invoice not yet due (daysPastDue <= 0) as contributing zero from that factor", () => {
    const notYetDue = calculateCollectionPriorityScore({
      outstandingAmount: "100.00",
      daysPastDue: 0,
      customerAvgDaysLate: null,
    });
    const overdue = calculateCollectionPriorityScore({
      outstandingAmount: "100.00",
      daysPastDue: 30,
      customerAvgDaysLate: null,
    });
    expect(notYetDue).toBeLessThan(overdue);
  });

  it("treats a customer with no payment history as neutral risk, between an early-payer and a late-payer at the same amount/age", () => {
    const earlyPayer = calculateCollectionPriorityScore({
      outstandingAmount: "500.00",
      daysPastDue: 20,
      customerAvgDaysLate: -30,
    });
    const noHistory = calculateCollectionPriorityScore({
      outstandingAmount: "500.00",
      daysPastDue: 20,
      customerAvgDaysLate: null,
    });
    const latePayer = calculateCollectionPriorityScore({
      outstandingAmount: "500.00",
      daysPastDue: 20,
      customerAvgDaysLate: 60,
    });
    expect(earlyPayer).toBeLessThan(noHistory);
    expect(noHistory).toBeLessThan(latePayer);
  });

  it("never returns a score outside 0-100 for extreme inputs", () => {
    const extreme = calculateCollectionPriorityScore({
      outstandingAmount: "999999999.00",
      daysPastDue: 100000,
      customerAvgDaysLate: 100000,
    });
    expect(extreme).toBe(100);

    const negative = calculateCollectionPriorityScore({
      outstandingAmount: "-100.00",
      daysPastDue: -50,
      customerAvgDaysLate: -1000,
    });
    expect(negative).toBe(0);
  });

  it("is deterministic for identical inputs", () => {
    const input = { outstandingAmount: "1234.56", daysPastDue: 42, customerAvgDaysLate: 7 };
    expect(calculateCollectionPriorityScore(input)).toBe(calculateCollectionPriorityScore({ ...input }));
  });
});
