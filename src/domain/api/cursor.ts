import { createHmac, timingSafeEqual } from "node:crypto";
import { apiErrors } from "./errors";

/**
 * Opaque, versioned, tamper-evident pagination cursors.
 *
 *   c1.<base64url(JSON {o,q,t,i})>.<base64url(first 16 bytes of HMAC-SHA256)>
 *
 *  - `c1` is the format version, so the encoding can change without ever mis-reading an old cursor.
 *  - `t`/`i` are the keyset position: the `created_at` (microsecond-exact text) and id of the last row returned.
 *  - `o` is the organization id and `q` a fingerprint of the endpoint + filters. The HMAC covers all of it, so a
 *    cursor minted for one organization, endpoint or filter set is REJECTED on another (400), and a hand-edited
 *    one fails the signature. The cursor is a position, never an authority: even a forged one could only select a
 *    different slice of the caller's OWN organization, because every query runs inside withTenant(<key's org>)
 *    behind row-level security - the HMAC is for integrity and to turn client bugs into a clear 400.
 *  - The signing secret is derived from NEXTAUTH_SECRET (already required in every environment), domain-separated.
 */
export const CURSOR_VERSION = "c1";
const MAC_BYTES = 16;

export interface CursorPosition {
  /** `created_at` of the last row, as microsecond-exact ISO text. */
  t: string;
  /** Id of the last row (tiebreak). */
  i: string;
}

export interface CursorScope {
  organizationId: string;
  /** Endpoint + canonical filters, e.g. "invoices|status=DRAFT". */
  query: string;
}

function signingKey(secret?: string): Buffer {
  const base = secret ?? process.env.NEXTAUTH_SECRET;
  if (!base) throw new Error("NEXTAUTH_SECRET must be set to sign pagination cursors.");
  return createHmac("sha256", "mm-api-cursor-v1").update(base).digest();
}

function mac(payload: string, secret?: string): Buffer {
  return createHmac("sha256", signingKey(secret)).update(payload).digest().subarray(0, MAC_BYTES);
}

export function encodeCursor(position: CursorPosition, scope: CursorScope, secret?: string): string {
  const payload = Buffer.from(JSON.stringify({ o: scope.organizationId, q: scope.query, t: position.t, i: position.i })).toString("base64url");
  return `${CURSOR_VERSION}.${payload}.${mac(payload, secret).toString("base64url")}`;
}

/** Decodes and verifies a cursor for `scope`; any defect (shape, version, signature, scope, content) throws `invalid_cursor` (400). */
export function decodeCursor(cursor: string, scope: CursorScope, secret?: string): CursorPosition {
  const parts = cursor.split(".");
  if (parts.length !== 3 || parts[0] !== CURSOR_VERSION || cursor.length > 600) throw apiErrors.invalidCursor();
  const [, payload, signature] = parts as [string, string, string];

  const expected = mac(payload, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw apiErrors.invalidCursor();

  let body: { o?: unknown; q?: unknown; t?: unknown; i?: unknown };
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw apiErrors.invalidCursor();
  }
  if (body.o !== scope.organizationId || body.q !== scope.query) throw apiErrors.invalidCursor();
  if (typeof body.t !== "string" || typeof body.i !== "string") throw apiErrors.invalidCursor();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(body.t)) throw apiErrors.invalidCursor();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.i)) throw apiErrors.invalidCursor();
  return { t: body.t, i: body.i };
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
