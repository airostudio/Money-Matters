/**
 * Pure helpers for the global search box (master spec s.56): normalising what the person typed, escaping it for a
 * LIKE pattern, and recognising an amount. Nothing here touches the database; the query text only ever reaches
 * Postgres as a BOUND PARAMETER (never concatenated into SQL), and this module makes sure that a `%` or `_` the
 * person typed is matched literally rather than acting as a wildcard.
 */

/** Fewer characters than this matches too much to be useful and costs a scan for nothing: the box stays quiet. */
export const MIN_QUERY_LENGTH = 2;
/** Longer input is truncated, not rejected: nobody searches for an 80+ character fragment of a name. */
export const MAX_QUERY_LENGTH = 80;
/** The hard LIMIT applied to every entity type in the one search statement. */
export const PER_KIND_LIMIT = 5;

/** The LIKE escape character. `!` is used (not backslash) so no string-literal escaping rules can ever bite. */
export const LIKE_ESCAPE = "!";

// Control characters (NUL in particular makes Postgres reject the parameter outright) and the bidi / zero-width
// formatting characters that make two visually identical strings differ.
// eslint-disable-next-line no-control-regex
const CONTROL_AND_FORMAT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
// A lone UTF-16 surrogate cannot be encoded as UTF-8, so the driver would fail on it.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * What the person typed, made safe to search with: a string, NFC-normalised, with control / lone-surrogate
 * characters removed, whitespace collapsed, truncated to MAX_QUERY_LENGTH characters. Returns null when what is
 * left is shorter than MIN_QUERY_LENGTH (the caller then does no work at all).
 */
export function normaliseQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(LONE_SURROGATE, "")
    .normalize("NFC")
    .replace(CONTROL_AND_FORMAT, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(cleaned);
  const bounded = chars.length > MAX_QUERY_LENGTH ? chars.slice(0, MAX_QUERY_LENGTH).join("").trim() : cleaned;
  return Array.from(bounded).length >= MIN_QUERY_LENGTH ? bounded : null;
}

/** Makes `%`, `_` and the escape character itself literal inside a LIKE pattern (used with `ESCAPE '!'`). */
export function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (c) => `${LIKE_ESCAPE}${c}`);
}

export interface LikePatterns {
  /** `text%` : the value STARTS with what was typed (ranked first). */
  prefix: string;
  /** `%text%` : the value CONTAINS what was typed. */
  contains: string;
}

export function likePatterns(query: string): LikePatterns {
  const escaped = escapeLike(query);
  return { prefix: `${escaped}%`, contains: `%${escaped}%` };
}

// 1,234.56 / 1234.5 / $1,234 / -50.00 / 0.5 . Digits only, at most 4 decimals (the ledger's scale), 15 integer digits.
const AMOUNT_GROUPED = /^[-+]?\$?\d{1,3}(?:,\d{3})+(?:\.\d{1,4})?$/;
const AMOUNT_PLAIN = /^[-+]?\$?\d{1,15}(?:\.\d{1,4})?$/;

/**
 * When the query looks like a money amount, its canonical decimal STRING (e.g. "$1,234.5" -> "1234.5"), else null.
 * It stays a string end to end (money is never a float): the database compares it as `numeric`. The sign is dropped
 * (the caller matches both signs for bank transactions, where a withdrawal is stored negative).
 */
export function parseAmountQuery(query: string): string | null {
  const q = query.trim();
  if (!AMOUNT_GROUPED.test(q) && !AMOUNT_PLAIN.test(q)) return null;
  const digits = q.replace(/[$,+-]/g, "");
  const [whole = "0", frac] = digits.split(".");
  if (whole.length > 15) return null;
  const wholeTrimmed = whole.replace(/^0+(?=\d)/, "");
  return frac ? `${wholeTrimmed}.${frac}` : wholeTrimmed;
}
