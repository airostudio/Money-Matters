import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook signatures (docs/api.md "Webhooks", docs/security.md section 16).
 *
 *   Mm-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]
 *   v1 = HMAC-SHA256( key = the whole secret string including its "whsec_" prefix,
 *                      message = "<t>.<raw request body>" )
 *
 * A second `v1=` appears while a secret rotation is inside its grace window (signed with the new AND the old secret), so a
 * consumer can switch over without downtime: it accepts the delivery if ANY v1 matches a secret it holds.
 *
 * `verifySignature` is the reference verifier and implements EXACTLY the algorithm published in docs/api.md; the unit tests
 * run the documented Node snippet's logic against this implementation.
 */
export const SIGNATURE_HEADER = "Mm-Signature";
/** Consumers should reject a delivery whose timestamp is further than this from their clock (replay protection). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const SECRET_PREFIX = "whsec_";

export function generateSigningSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function computeSignature(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
}

/** Builds the header value: one `v1=` per secret (the current secret first). */
export function buildSignatureHeader(secrets: readonly string[], timestampSeconds: number, rawBody: string): string {
  if (secrets.length === 0) throw new Error("At least one signing secret is required.");
  return [`t=${timestampSeconds}`, ...secrets.map((s) => `v1=${computeSignature(s, timestampSeconds, rawBody)}`)].join(",");
}

export type VerifyResult = { valid: true } | { valid: false; reason: "malformed" | "timestamp_out_of_tolerance" | "no_matching_signature" };

export function verifySignature(
  header: string,
  rawBody: string,
  secrets: readonly string[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): VerifyResult {
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === null || candidates.length === 0) return { valid: false, reason: "malformed" };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { valid: false, reason: "timestamp_out_of_tolerance" };
  for (const secret of secrets) {
    const expected = Buffer.from(computeSignature(secret, timestamp, rawBody), "hex");
    for (const candidate of candidates) {
      const given = Buffer.from(candidate, "hex");
      if (given.length === expected.length && timingSafeEqual(given, expected)) return { valid: true };
    }
  }
  return { valid: false, reason: "no_matching_signature" };
}
