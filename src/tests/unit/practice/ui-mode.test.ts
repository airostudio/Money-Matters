import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/components/shell/nav-config";
import { DEFAULT_UI_MODE, labelForMode, parseUiMode } from "@/components/shell/ui-mode";

describe("Business vs Accountant presentation mode (master spec s.72)", () => {
  it("parses only the two known values; anything else is the default (Business)", () => {
    expect(parseUiMode("ACCOUNTANT")).toBe("ACCOUNTANT");
    expect(parseUiMode("BUSINESS")).toBe("BUSINESS");
    for (const bad of [undefined, null, "", "accountant", "ADMIN", "<script>"]) expect(parseUiMode(bad as string | undefined)).toBe(DEFAULT_UI_MODE);
    expect(DEFAULT_UI_MODE).toBe("BUSINESS");
  });

  it("relabels the accounting terminology by mode and leaves every other label alone", () => {
    expect(labelForMode("Accounting", "ACCOUNTANT")).toBe("General Ledger");
    expect(labelForMode("Journals", "ACCOUNTANT")).toBe("Journals");
    expect(labelForMode("Trial Balance", "ACCOUNTANT")).toBe("Trial Balance");
    expect(labelForMode("Accounting", "BUSINESS")).toBe("Accounts & reports");
    expect(labelForMode("Journals", "BUSINESS")).toBe("Manual entries");
    expect(labelForMode("Trial Balance", "BUSINESS")).toBe("Account balances");
    expect(labelForMode("Client requests", "BUSINESS")).toBe("Accountant requests");
    expect(labelForMode("Sales", "BUSINESS")).toBe("Sales");
    expect(labelForMode("Sales", "ACCOUNTANT")).toBe("Sales");
  });

  it("the Practice entry point exists only in Accountant mode and points outside the organization; mode adds no permission", () => {
    const practice = NAV_ITEMS.filter((i) => i.absoluteHref === "/practice");
    expect(practice.length).toBe(1);
    expect(practice[0]!.onlyInMode).toBe("ACCOUNTANT");
    // Presentation only: no nav item is gated by mode other than the practice entry, and no item requires a permission the other mode lacks.
    expect(NAV_ITEMS.filter((i) => i.onlyInMode).map((i) => i.label)).toEqual(["Practice"]);
    // The client inbox is in both modes and is permission-gated, not mode-gated.
    const requests = NAV_ITEMS.find((i) => i.href === "/requests");
    expect(requests).toMatchObject({ permission: "client_request:read" });
    expect(requests!.onlyInMode).toBeUndefined();
  });
});
