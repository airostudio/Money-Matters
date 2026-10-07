import { describe, expect, it } from "vitest";
import { MAX_WEBHOOK_URL_LENGTH, parseWebhookUrl, resolveAndVet, type Resolver } from "@/domain/webhooks/url-guard";

function ok(url: string) {
  const v = parseWebhookUrl(url);
  if (!v.ok) throw new Error(`expected ${url} to be accepted: ${v.reason}`);
  return v;
}

describe("parseWebhookUrl: static rules", () => {
  it("accepts an https URL on a public host name (default port or explicit 443), path and query kept", () => {
    expect(ok("https://hooks.example.com/mm/events?x=1").url.pathname).toBe("/mm/events");
    expect(ok("https://hooks.example.com:443/a").port).toBe(443);
    expect(ok("  https://Hooks.Example.COM/a  ").hostname).toBe("hooks.example.com");
    expect(ok("https://hooks.example.com./a").hostname).toBe("hooks.example.com");
    expect(ok("https://xn--bcher-kva.example/").hostname).toBe("xn--bcher-kva.example");
  });

  it.each([
    ["http scheme", "http://hooks.example.com/"],
    ["ftp scheme", "ftp://hooks.example.com/"],
    ["file scheme", "file:///etc/passwd"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/plain,hi"],
    ["gopher scheme", "gopher://hooks.example.com/"],
    ["credentials", "https://user:pass@hooks.example.com/"],
    ["username only", "https://user@hooks.example.com/"],
    ["non-443 port", "https://hooks.example.com:8443/"],
    ["port 80", "https://hooks.example.com:80/"],
    ["fragment", "https://hooks.example.com/a#frag"],
    ["no host", "https:///path"],
    ["empty", ""],
    ["spaces", "https://hooks.example.com/a b"],
    ["newline injection", "https://hooks.example.com/a\r\nHost: evil"],
    ["not a URL", "hooks.example.com"],
    ["localhost", "https://localhost/"],
    ["sub.localhost", "https://api.localhost/"],
    [".local", "https://printer.local/"],
    [".internal", "https://svc.internal/"],
    ["single label", "https://intranet/"],
    ["too long", `https://hooks.example.com/${"a".repeat(MAX_WEBHOOK_URL_LENGTH)}`],
  ])("rejects %s", (_name, url) => {
    expect(parseWebhookUrl(url).ok, url).toBe(false);
  });

  it.each([
    ["IPv4 loopback", "https://127.0.0.1/"],
    ["IPv4 private 10/8", "https://10.1.2.3/"],
    ["IPv4 private 172.16", "https://172.16.0.9/"],
    ["IPv4 private 192.168", "https://192.168.1.1/"],
    ["metadata address", "https://169.254.169.254/latest/meta-data/"],
    ["CGNAT", "https://100.64.0.1/"],
    ["unspecified", "https://0.0.0.0/"],
    ["IPv6 loopback", "https://[::1]/"],
    ["IPv6 ULA", "https://[fd00::1]/"],
    ["IPv6 link-local", "https://[fe80::1]/"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped metadata", "https://[::ffff:169.254.169.254]/"],
    // WHATWG URL canonicalises these spellings to dotted decimal - the guard must see the canonical form.
    ["decimal integer loopback", "https://2130706433/"],
    ["hex loopback", "https://0x7f000001/"],
    ["octal loopback", "https://0177.0.0.1/"],
    ["short form loopback", "https://127.1/"],
    ["hex dotted loopback", "https://0x7f.0x0.0x0.0x1/"],
  ])("rejects an IP-literal host: %s", (_name, url) => {
    expect(parseWebhookUrl(url).ok, url).toBe(false);
  });

  it("allows a PUBLIC IP literal (still subject to the connection-time checks)", () => {
    const v = ok("https://93.184.216.34/hook");
    expect(v.literalIp).toBe("93.184.216.34");
  });
});

function resolverOf(answers: string[] | Error): Resolver {
  return async () => {
    if (answers instanceof Error) throw answers;
    return answers.map((address) => ({ address, family: (address.includes(":") ? 6 : 4) as 4 | 6 }));
  };
}

describe("resolveAndVet: every resolved address must be public", () => {
  const host = ok("https://hooks.example.com/");

  it("accepts a host whose answers are all public", async () => {
    const r = await resolveAndVet(host, resolverOf(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]));
    expect(r.ok).toBe(true);
  });

  it.each([
    ["a private address", ["10.0.0.5"]],
    ["loopback", ["127.0.0.1"]],
    ["the metadata address", ["169.254.169.254"]],
    ["IPv6 loopback", ["::1"]],
    ["an IPv4-mapped private IPv6 address", ["::ffff:192.168.0.10"]],
    ["IPv6 ULA", ["fd00::5"]],
    ["ONE private among several public answers", ["93.184.216.34", "8.8.8.8", "10.0.0.1"]],
    ["a private answer listed FIRST", ["192.168.1.1", "93.184.216.34"]],
  ])("refuses a host that resolves to %s", async (_name, answers) => {
    const r = await resolveAndVet(host, resolverOf(answers));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorClass).toBe("ssrf_blocked");
      expect(r.reason).toMatch(/non-public/);
    }
  });

  it("reports DNS failure and empty answers as dns errors, not as success", async () => {
    const nx = Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    expect(await resolveAndVet(host, resolverOf(nx))).toMatchObject({ ok: false, errorClass: "dns" });
    expect(await resolveAndVet(host, resolverOf([]))).toMatchObject({ ok: false, errorClass: "dns" });
  });

  it("classifies an IP-literal host directly without ever calling the resolver", async () => {
    let called = false;
    const spy: Resolver = async () => {
      called = true;
      return [];
    };
    const lit = ok("https://93.184.216.34/");
    expect((await resolveAndVet(lit, spy)).ok).toBe(true);
    expect(called).toBe(false);
  });
});
