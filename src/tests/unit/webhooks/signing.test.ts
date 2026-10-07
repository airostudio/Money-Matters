import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SIGNATURE_TOLERANCE_SECONDS, buildSignatureHeader, computeSignature, generateSigningSecret, verifySignature } from "@/domain/webhooks/signing";
import { NODE_VERIFY_SNIPPET, PYTHON_VERIFY_SNIPPET } from "@/domain/webhooks/verification-snippets";

const BODY = JSON.stringify({ id: "evt_1", type: "invoice.created", data: { object: { total: { amount: "1100.00", currency: "AUD" } } } });
const SECRET = "whsec_test_secret_value_0123456789";
const OLD_SECRET = "whsec_old_secret_value_9876543210";

describe("generateSigningSecret", () => {
  it("is whsec_ plus 256 bits of base64url randomness, and unique", () => {
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe("signature scheme: HMAC-SHA256 over '<t>.<raw body>'", () => {
  it("matches an independently computed known vector", () => {
    // printf '%s' '1700000000.{"a":1}' | openssl dgst -sha256 -hmac 'whsec_k'
    expect(computeSignature("whsec_k", 1700000000, '{"a":1}')).toBe("a252a4340d8bbbdbac8643a2812cc7d628ad79bfba544bff054ac2fa10f795a2");
    expect(computeSignature("whsec_k", 1700000000, '{"a":1}')).not.toBe(computeSignature("whsec_k", 1700000001, '{"a":1}'));
    expect(computeSignature("whsec_k", 1700000000, '{"a":1}')).not.toBe(computeSignature("whsec_k", 1700000000, '{"a":2}'));
    expect(computeSignature("whsec_k", 1700000000, '{"a":1}')).not.toBe(computeSignature("whsec_j", 1700000000, '{"a":1}'));
  });

  it("header format is t=<unix>,v1=<hex>; a rotation window adds a second v1 (new secret first)", () => {
    const single = buildSignatureHeader([SECRET], 1700000000, BODY);
    expect(single).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    const both = buildSignatureHeader([SECRET, OLD_SECRET], 1700000000, BODY);
    const parts = both.split(",");
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe(`v1=${computeSignature(SECRET, 1700000000, BODY)}`);
    expect(parts[2]).toBe(`v1=${computeSignature(OLD_SECRET, 1700000000, BODY)}`);
    expect(() => buildSignatureHeader([], 1, "x")).toThrow();
  });

  it("verifies with the current secret, with the old secret during rotation, and rejects the wrong one", () => {
    const now = 1700000100;
    const header = buildSignatureHeader([SECRET, OLD_SECRET], 1700000000, BODY);
    expect(verifySignature(header, BODY, [SECRET], now)).toEqual({ valid: true });
    expect(verifySignature(header, BODY, [OLD_SECRET], now)).toEqual({ valid: true });
    expect(verifySignature(header, BODY, ["whsec_other"], now)).toEqual({ valid: false, reason: "no_matching_signature" });
    // After the grace window only the new secret signs: a consumer still holding only the OLD secret fails.
    const after = buildSignatureHeader([SECRET], 1700000000, BODY);
    expect(verifySignature(after, BODY, [OLD_SECRET], now).valid).toBe(false);
  });

  it("any change to the body or timestamp invalidates the signature", () => {
    const now = 1700000100;
    const header = buildSignatureHeader([SECRET], 1700000000, BODY);
    expect(verifySignature(header, BODY + " ", [SECRET], now).valid).toBe(false);
    expect(verifySignature(header.replace("t=1700000000", "t=1700000001"), BODY, [SECRET], now).valid).toBe(false);
  });

  it("enforces the 5-minute timestamp tolerance both ways (replay protection)", () => {
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    const t = 1700000000;
    const header = buildSignatureHeader([SECRET], t, BODY);
    expect(verifySignature(header, BODY, [SECRET], t + 300).valid).toBe(true);
    expect(verifySignature(header, BODY, [SECRET], t + 301)).toEqual({ valid: false, reason: "timestamp_out_of_tolerance" });
    expect(verifySignature(header, BODY, [SECRET], t - 300).valid).toBe(true);
    expect(verifySignature(header, BODY, [SECRET], t - 301).valid).toBe(false);
  });

  it("rejects malformed headers without throwing", () => {
    for (const bad of ["", "garbage", "t=abc,v1=00", "v1=" + "0".repeat(64), "t=1700000000", "t=1700000000,v1=zz", `t=1700000000,v1=${"0".repeat(63)}`]) {
      expect(verifySignature(bad, BODY, [SECRET], 1700000000).valid, bad).toBe(false);
    }
  });
});

describe("the documented verification snippets implement the same algorithm as the signer", () => {
  const nodeVerify = new Function("require", "module", `${NODE_VERIFY_SNIPPET}; return module.exports.verifyMoneyMattersSignature;`)(
    (name: string) => require(name),
    { exports: {} },
  ) as (raw: string, header: string, secrets: string[], tolerance?: number) => boolean;

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  it("Node snippet accepts a real delivery signature (current, old, both) and rejects tampering and stale timestamps", () => {
    const t = nowSeconds();
    const header = buildSignatureHeader([SECRET, OLD_SECRET], t, BODY);
    expect(nodeVerify(BODY, header, [SECRET])).toBe(true);
    expect(nodeVerify(BODY, header, [OLD_SECRET])).toBe(true);
    expect(nodeVerify(BODY, header, ["whsec_wrong"])).toBe(false);
    expect(nodeVerify(BODY + "x", header, [SECRET])).toBe(false);
    const stale = buildSignatureHeader([SECRET], t - 301, BODY);
    expect(nodeVerify(BODY, stale, [SECRET])).toBe(false);
    expect(nodeVerify(BODY, stale, [SECRET], 400)).toBe(true);
    expect(nodeVerify(BODY, "t=NaN,v1=00", [SECRET])).toBe(false);
    expect(nodeVerify(BODY, "", [SECRET])).toBe(false);
  });

  it("Node snippet and reference verifier agree on a table of cases", () => {
    const t = nowSeconds();
    const cases: Array<[string, string, string[]]> = [
      [BODY, buildSignatureHeader([SECRET], t, BODY), [SECRET]],
      [BODY, buildSignatureHeader([SECRET], t, BODY), ["nope"]],
      [BODY, buildSignatureHeader([SECRET], t - 1000, BODY), [SECRET]],
      ["{}", buildSignatureHeader([SECRET], t, "{ }"), [SECRET]],
      [BODY, buildSignatureHeader([OLD_SECRET, SECRET], t, BODY), [SECRET]],
    ];
    for (const [body, header, secrets] of cases) expect(nodeVerify(body, header, secrets)).toBe(verifySignature(header, body, secrets).valid);
  });

  const hasPython = (() => {
    try {
      execFileSync("python3", ["-I", "-c", "import hmac"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasPython)("Python snippet verifies a real delivery signature and rejects tampering and stale timestamps", () => {
    const t = nowSeconds();
    const good = buildSignatureHeader([SECRET, OLD_SECRET], t, BODY);
    const stale = buildSignatureHeader([SECRET], t - 301, BODY);
    const script = `${PYTHON_VERIFY_SNIPPET}
import json, sys
cases = json.loads(sys.stdin.read())
print(json.dumps([verify_money_matters_signature(c["body"].encode(), c["header"], c["secrets"]) for c in cases]))
`;
    const cases = [
      { body: BODY, header: good, secrets: [SECRET] },
      { body: BODY, header: good, secrets: [OLD_SECRET] },
      { body: BODY, header: good, secrets: ["whsec_wrong"] },
      { body: BODY + "x", header: good, secrets: [SECRET] },
      { body: BODY, header: stale, secrets: [SECRET] },
      { body: BODY, header: "t=abc,v1=00", secrets: [SECRET] },
    ];
    const out = execFileSync("python3", ["-I", "-c", script], { input: JSON.stringify(cases) }).toString();
    expect(JSON.parse(out)).toEqual([true, true, false, false, false, false]);
  });

  it("docs/api.md contains both snippets verbatim", () => {
    const docs = readFileSync(path.resolve(__dirname, "../../../../docs/api.md"), "utf8");
    expect(docs).toContain(NODE_VERIFY_SNIPPET);
    expect(docs).toContain(PYTHON_VERIFY_SNIPPET);
  });
});
