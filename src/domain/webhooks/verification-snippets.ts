/**
 * The consumer-side verification snippets published in docs/api.md and shown in Settings -> Webhooks. They live here as
 * the single source so a test can (a) execute them against the real signer and (b) assert the docs contain them verbatim.
 */
export const NODE_VERIFY_SNIPPET = `const crypto = require("crypto");

// rawBody: the request body EXACTLY as received (a string/Buffer) - never JSON.stringify(parsedBody).
// header:  the value of the Mm-Signature header.
// secrets: every signing secret you currently accept (two during a rotation).
function verifyMoneyMattersSignature(rawBody, header, secrets, toleranceSeconds = 300) {
  const parts = String(header).split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\\d+$/.test(t) || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false; // replay protection
  for (const secret of secrets) {
    const expected = crypto.createHmac("sha256", secret).update(t + "." + rawBody).digest();
    for (const sig of signatures) {
      const given = Buffer.from(sig, "hex");
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return true;
    }
  }
  return false;
}

module.exports = { verifyMoneyMattersSignature };`;

export const PYTHON_VERIFY_SNIPPET = `import hashlib
import hmac
import time


def verify_money_matters_signature(raw_body: bytes, header: str, secrets, tolerance_seconds: int = 300) -> bool:
    # raw_body: the request body EXACTLY as received (bytes). header: the Mm-Signature header value.
    parts = [p.strip().split("=", 1) for p in header.split(",") if "=" in p]
    t = next((v for k, v in parts if k == "t"), None)
    signatures = [v for k, v in parts if k == "v1"]
    if t is None or not t.isdigit() or not signatures:
        return False
    if abs(time.time() - int(t)) > tolerance_seconds:  # replay protection
        return False
    for secret in secrets:
        expected = hmac.new(secret.encode(), t.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
        if any(hmac.compare_digest(expected, s) for s in signatures):
            return True
    return False`;
