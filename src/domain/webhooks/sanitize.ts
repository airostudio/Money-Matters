/** Longest response excerpt kept in the delivery log. */
export const MAX_EXCERPT_CHARS = 1000;
/** Longest error message kept on a delivery row. */
export const MAX_ERROR_CHARS = 300;

/** Code points replaced by a space: C0/C1 controls, DEL, zero-width and bidi formatting, line/paragraph separators, BOM, U+FFFD. */
function isUnsafeCodePoint(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff ||
    cp === 0xfffd
  );
}

/**
 * Turns an untrusted response body (or error text) from a customer's server into something safe to store and render:
 * decoded as UTF-8 with replacement, every control character (NUL, ANSI escapes, bidi overrides, line separators)
 * replaced by a space, whitespace collapsed, length-capped. The UI also renders it as plain text, never HTML - this is
 * the second layer.
 */
export function sanitiseExcerpt(input: Buffer | string | null | undefined, max: number = MAX_EXCERPT_CHARS): string | null {
  if (input === null || input === undefined) return null;
  const text = typeof input === "string" ? input : input.toString("utf8");
  let out = "";
  for (const ch of text) {
    out += isUnsafeCodePoint(ch.codePointAt(0) as number) ? " " : ch;
  }
  const cleaned = out.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function sanitiseError(message: string): string {
  return sanitiseExcerpt(message, MAX_ERROR_CHARS) ?? "error";
}
