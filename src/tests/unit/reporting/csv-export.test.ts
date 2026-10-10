import { describe, expect, it } from "vitest";
import { buildProfitAndLoss } from "@/domain/reporting/financial-statements";
import { profitAndLossToCsv } from "@/domain/reporting/csv-export";

describe("profitAndLossToCsv", () => {
  it("renders a header, each line, and the subtotals as CSV rows", () => {
    const report = buildProfitAndLoss(
      [
        { accountId: "sales", code: "4000", name: "Sales", type: "REVENUE", subType: null, totalDebit: "0", totalCredit: "1000.0000" },
        { accountId: "rent", code: "6000", name: "Rent", type: "EXPENSE", subType: null, totalDebit: "400.0000", totalCredit: "0" },
      ],
      "AUD",
    );
    const csv = profitAndLossToCsv(report);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Section,Code,Account,Amount");
    expect(lines).toContain("Revenue,4000,Sales,1000.0000");
    expect(lines).toContain(",,Net Profit,600.0000");
  });

  it("quotes a cell containing a comma", () => {
    const report = buildProfitAndLoss(
      [
        {
          accountId: "sales",
          code: "4000",
          name: "Sales, Retail",
          type: "REVENUE",
          subType: null,
          totalDebit: "0",
          totalCredit: "500.0000",
        },
      ],
      "AUD",
    );
    const csv = profitAndLossToCsv(report);
    expect(csv).toContain('"Sales, Retail"');
  });
});
