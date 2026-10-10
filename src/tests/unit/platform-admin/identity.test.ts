import { describe, expect, it } from "vitest";
import { isPlatformAdminEmail, parsePlatformAdminEmails } from "@/domain/platform-admin/identity";
import { csvCell, toCsv } from "@/domain/platform-admin/export-service";
import { normalizeEmail } from "@/domain/auth/email";

describe("platform admin identity (pure)", () => {
  const configured = "typhoon.tall69@gmail.com";

  it("fails closed: unset, empty, whitespace or only commas means nobody is an admin", () => {
    for (const raw of [undefined, null, "", "   ", ",", " , ,, "]) {
      expect(parsePlatformAdminEmails(raw).size).toBe(0);
      expect(isPlatformAdminEmail("typhoon.tall69@gmail.com", raw)).toBe(false);
      expect(isPlatformAdminEmail("", raw)).toBe(false);
    }
  });

  it("never treats an empty/missing email as an admin, even if the list contains blanks", () => {
    expect(isPlatformAdminEmail("", ",,")).toBe(false);
    expect(isPlatformAdminEmail(undefined, configured)).toBe(false);
    expect(isPlatformAdminEmail("   ", configured)).toBe(false);
  });

  it("matches the configured email regardless of case and surrounding whitespace, on both sides", () => {
    expect(isPlatformAdminEmail("typhoon.tall69@gmail.com", configured)).toBe(true);
    expect(isPlatformAdminEmail("  Typhoon.Tall69@GMAIL.com ", configured)).toBe(true);
    expect(isPlatformAdminEmail("typhoon.tall69@gmail.com", "  TYPHOON.Tall69@gmail.com  ")).toBe(true);
  });

  it("supports a comma-separated list and ignores non-members", () => {
    const raw = " a@x.test , Typhoon.Tall69@gmail.com ,, b@x.test";
    expect(isPlatformAdminEmail("typhoon.tall69@gmail.com", raw)).toBe(true);
    expect(isPlatformAdminEmail("b@x.test", raw)).toBe(true);
    expect(isPlatformAdminEmail("c@x.test", raw)).toBe(false);
  });

  it("does not match look-alikes (suffix, prefix, plus-alias, extra characters, substring)", () => {
    for (const email of [
      "typhoon.tall69@gmail.com.evil.test",
      "xtyphoon.tall69@gmail.com",
      "typhoon.tall69+admin@gmail.com",
      "typhoon.tall69@gmail.co",
      "typhoon.tall69@gmail.com​",
      "typhoon.tall69@gmail.com,evil@x.test",
      "typhoon.tall6@gmail.com",
    ]) {
      expect(isPlatformAdminEmail(email, configured)).toBe(false);
    }
  });

  it("normalizeEmail is trim + lowercase", () => {
    expect(normalizeEmail("  A@B.Test ")).toBe("a@b.test");
  });
});

describe("CSV export escaping", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  });

  it("neutralises spreadsheet formula injection", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("renders dates as ISO and nullish as empty", () => {
    expect(csvCell(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [[1, undefined]])).toBe("a,b\r\n1,\r\n");
  });
});
