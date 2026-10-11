import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  escapeLike,
  likePatterns,
  normaliseQuery,
  parseAmountQuery,
} from "@/domain/search/query";

describe("normaliseQuery", () => {
  it("trims, collapses whitespace and keeps the text otherwise as typed", () => {
    expect(normaliseQuery("  Acme   Pty\tLtd \n")).toBe("Acme Pty Ltd");
  });

  it("returns null for anything that is not a string of at least two characters", () => {
    for (const bad of [undefined, null, 5, {}, [], "", " ", "a", "  a  ", "\u0000a\u0000", "​​"]) {
      expect(normaliseQuery(bad), String(bad)).toBeNull();
    }
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(normaliseQuery("ab")).toBe("ab");
  });

  it("strips NUL and other control / bidi / zero-width characters (Postgres rejects NUL in text)", () => {
    expect(normaliseQuery("ac\u0000me")).toBe("ac me");
    expect(normaliseQuery("ac‮me")).toBe("ac me");
    expect(normaliseQuery("ac​me")).toBe("ac me");
    expect(normaliseQuery("a\u0007\u001bb")).toBe("a b");
  });

  it("drops lone surrogates but keeps real astral characters and combining text, NFC-normalised", () => {
    expect(normaliseQuery("ab\ud800")).toBe("ab");
    expect(normaliseQuery("ab\udc00cd")).toBe("abcd");
    expect(normaliseQuery("ab😀")).toBe("ab😀");
    expect(normaliseQuery("café")).toBe("café"); // e + combining acute -> é
    expect(normaliseQuery("東京")).toBe("東京");
  });

  it("truncates (never rejects) over-long input, by characters, not UTF-16 units", () => {
    const long = "x".repeat(500);
    expect(Array.from(normaliseQuery(long)!)).toHaveLength(MAX_QUERY_LENGTH);
    const astral = "😀".repeat(200);
    expect(Array.from(normaliseQuery(astral)!)).toHaveLength(MAX_QUERY_LENGTH);
  });
});

describe("LIKE escaping", () => {
  it("makes %, _ and the escape character literal", () => {
    expect(escapeLike("100%")).toBe("100!%");
    expect(escapeLike("a_b")).toBe("a!_b");
    expect(escapeLike("wow!")).toBe("wow!!");
    expect(escapeLike("%_!%_!")).toBe("!%!_!!!%!_!!");
  });

  it("leaves quotes, backslashes, SQL fragments and unicode untouched (they are bound parameters, not SQL)", () => {
    for (const s of ["O'Brien", "a\\b", "'; DROP TABLE contacts; --", "Zoë 東京", '"quoted"', "a\\%b"]) {
      expect(escapeLike(s).replace(/!%|!_|!!/g, "")).toBe(s.replace(/[%_!]/g, ""));
    }
  });

  it("builds prefix and contains patterns from the escaped text", () => {
    expect(likePatterns("a%b")).toEqual({ prefix: "a!%b%", contains: "%a!%b%" });
    expect(likePatterns("Acme")).toEqual({ prefix: "Acme%", contains: "%Acme%" });
  });

  it("a query of only wildcards stays a literal (the pattern is not 'match everything')", () => {
    expect(likePatterns("%%").contains).toBe("%!%!%%");
    expect(likePatterns("__").prefix).toBe("!_!_%");
  });
});

describe("parseAmountQuery", () => {
  it("canonicalises amounts as decimal strings, dropping $, commas and sign", () => {
    const cases: Array<[string, string]> = [
      ["1234.50", "1234.50"],
      ["1,234.5", "1234.5"],
      ["$1,234,567.89", "1234567.89"],
      ["-50.00", "50.00"],
      ["+7", "7"],
      ["0.5", "0.5"],
      ["007", "7"],
      ["12.3456", "12.3456"],
      ["  99  ", "99"],
    ];
    for (const [input, expected] of cases) expect(parseAmountQuery(input), input).toBe(expected);
  });

  it("does not treat words, ids, dates or malformed numbers as amounts", () => {
    for (const bad of ["INV-1042", "1,23", "12,34.5", "1.23456", "1e5", "12.", ".5", "2026-03-10", "abc", "1 000", "0x10", "", "$", "1,,000", "1".repeat(16)]) {
      expect(parseAmountQuery(bad), bad).toBeNull();
    }
  });

  it("never goes through a float: a 15-digit amount keeps every digit", () => {
    expect(parseAmountQuery("123456789012345.1234")).toBe("123456789012345.1234");
  });
});
