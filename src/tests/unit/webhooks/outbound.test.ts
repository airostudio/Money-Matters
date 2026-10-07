import { describe, expect, it } from "vitest";
import { MAX_REQUEST_BYTES, TransportError, sendWebhook, type DeliveryRequest } from "@/domain/webhooks/outbound";
import { fakeResolver, fakeTransport, PUBLIC_IP } from "../../helpers/webhooks";

const REQUEST: DeliveryRequest = { url: "https://hooks.example.com/mm", headers: { "Content-Type": "application/json" }, body: '{"hello":"world"}' };

describe("sendWebhook with injected resolver and transport (offline)", () => {
  it("connects to the VALIDATED address (not the host name) and reports success on 2xx", async () => {
    const transport = fakeTransport(() => ({ status: 204, bodyExcerpt: Buffer.alloc(0) }));
    const result = await sendWebhook(REQUEST, { resolver: fakeResolver(), transport });
    expect(result).toMatchObject({ success: true, statusCode: 204, errorClass: null });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.address).toEqual({ address: PUBLIC_IP, family: 4 });
    expect(transport.calls[0]!.hostname).toBe("hooks.example.com");
    expect(transport.calls[0]!.url.protocol).toBe("https:");
  });

  describe("hostile DNS: the HTTP client is NEVER invoked", () => {
    it.each([
      ["private IPv4", ["10.0.0.7"]],
      ["loopback", ["127.0.0.1"]],
      ["cloud metadata", ["169.254.169.254"]],
      ["IPv6 loopback", ["::1"]],
      ["IPv6 ULA", ["fc00::1"]],
      ["IPv4-mapped IPv6 private", ["::ffff:10.0.0.1"]],
      ["IPv4-mapped IPv6 metadata", ["::ffff:a9fe:a9fe"]],
      ["mixed public + private answers", [PUBLIC_IP, "192.168.0.1"]],
      ["CGNAT", ["100.64.1.1"]],
    ])("refuses a host resolving to %s", async (_name, answers) => {
      const transport = fakeTransport();
      const result = await sendWebhook(REQUEST, { resolver: fakeResolver({ "hooks.example.com": answers }), transport });
      expect(result).toMatchObject({ success: false, errorClass: "ssrf_blocked", statusCode: null });
      expect(transport.calls).toHaveLength(0);
    });

    it("refuses a stored URL that was valid once but is not now (private IP literal, http, credentials, wrong port) without any lookup or request", async () => {
      for (const url of ["https://10.0.0.1/x", "http://hooks.example.com/", "https://u:p@hooks.example.com/", "https://hooks.example.com:8443/", "https://localhost/"]) {
        const resolver = fakeResolver();
        const transport = fakeTransport();
        const result = await sendWebhook({ ...REQUEST, url }, { resolver, transport });
        expect(result.errorClass, url).toBe("ssrf_blocked");
        expect(transport.calls, url).toHaveLength(0);
        expect(resolver.calls, url).toHaveLength(0);
      }
    });

    it("DNS rebinding: the host is resolved ONCE and the vetted address is what the transport receives, even if DNS would now answer differently", async () => {
      let lookups = 0;
      // First answer is public (passes the check); any later answer would be the metadata address.
      const rebinding = async () => {
        lookups += 1;
        return [{ address: lookups === 1 ? PUBLIC_IP : "169.254.169.254", family: 4 as const }];
      };
      const transport = fakeTransport();
      const result = await sendWebhook(REQUEST, { resolver: rebinding, transport });
      expect(result.success).toBe(true);
      expect(lookups).toBe(1); // no second resolution exists for the answer to change in
      expect(transport.calls[0]!.address.address).toBe(PUBLIC_IP);
    });

    it("a DNS failure is a dns error, retried like any failure, with no request made", async () => {
      const transport = fakeTransport();
      const result = await sendWebhook(REQUEST, {
        resolver: async () => {
          throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
        },
        transport,
      });
      expect(result).toMatchObject({ success: false, errorClass: "dns" });
      expect(transport.calls).toHaveLength(0);
    });
  });

  describe("responses", () => {
    it.each([301, 302, 303, 307, 308])("treats HTTP %i as a failure and does not follow the redirect (even to the metadata address)", async (status) => {
      const transport = fakeTransport(() => ({ status, bodyExcerpt: Buffer.from("Moved: http://169.254.169.254/latest/meta-data/") }));
      const result = await sendWebhook(REQUEST, { resolver: fakeResolver(), transport });
      expect(result).toMatchObject({ success: false, errorClass: "redirect", statusCode: status });
      expect(transport.calls).toHaveLength(1); // exactly one request: the Location was never requested
    });

    it.each([400, 401, 404, 410, 429, 500, 502, 503])("treats HTTP %i as a failure with the status recorded", async (status) => {
      const transport = fakeTransport(() => ({ status, bodyExcerpt: Buffer.from("nope") }));
      const result = await sendWebhook(REQUEST, { resolver: fakeResolver(), transport });
      expect(result).toMatchObject({ success: false, errorClass: "http_error", statusCode: status, excerpt: "nope" });
    });

    it("stores a truncated, control-stripped excerpt of a huge hostile body", async () => {
      const huge = Buffer.from(`${"A".repeat(20_000)}\u0000\u001b[2J`);
      const transport = fakeTransport(() => ({ status: 200, bodyExcerpt: huge }));
      const result = await sendWebhook(REQUEST, { resolver: fakeResolver(), transport, maxResponseBytes: 8 * 1024 });
      expect(result.success).toBe(true);
      expect(result.excerpt!.length).toBeLessThanOrEqual(1000);
      expect(result.excerpt).not.toMatch(new RegExp(String.fromCharCode(0)));
    });
  });

  describe("failures of the network itself", () => {
    it.each([
      ["timeout", new TransportError("timeout", "No complete response within 10s"), "timeout"],
      ["connection refused", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), "connect"],
      ["connection reset", Object.assign(new Error("reset"), { code: "ECONNRESET" }), "connect"],
      ["TLS certificate failure", Object.assign(new Error("cert"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "tls"],
      ["hostname mismatch", Object.assign(new Error("cert"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "tls"],
      ["something else", new Error("boom"), "network"],
    ])("classifies %s as %s and never throws", async (_name, error, expected) => {
      const transport = fakeTransport(() => {
        throw error;
      });
      const result = await sendWebhook(REQUEST, { resolver: fakeResolver(), transport });
      expect(result).toMatchObject({ success: false, errorClass: expected, statusCode: null });
      expect(result.errorMessage).toBeTruthy();
    });
  });

  it("refuses an oversize request body before any lookup", async () => {
    const resolver = fakeResolver();
    const transport = fakeTransport();
    const result = await sendWebhook({ ...REQUEST, body: "x".repeat(MAX_REQUEST_BYTES + 1) }, { resolver, transport });
    expect(result.errorClass).toBe("request_too_large");
    expect(resolver.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("passes the configured timeout and response cap to the transport", async () => {
    const transport = fakeTransport();
    await sendWebhook(REQUEST, { resolver: fakeResolver(), transport, timeoutMs: 1234, maxResponseBytes: 99 });
    expect(transport.calls[0]).toMatchObject({ timeoutMs: 1234, maxResponseBytes: 99 });
  });
});
