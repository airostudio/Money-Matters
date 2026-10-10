import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createHttpsTransport } from "@/domain/webhooks/outbound";
import { SLACK_ALLOWED_HOSTS, sendSlackMessage } from "@/domain/integrations/providers/slack-incoming-webhook";
import type { ChannelMessage } from "@/domain/integrations/provider";
import { fakeResolver } from "../../helpers/webhooks";

/**
 * The Slack provider's send path through the REAL HTTPS transport (pinned lookup, real TLS verification, no redirects)
 * against a real local TLS server standing in for Slack. Offline and deterministic: the stand-in host name does not exist in
 * DNS. This is the closest to "delivery" that can be verified without a Slack workspace; delivery to Slack itself was NOT
 * verified. The `allowedHosts` override exists only for this test - every production path uses SLACK_ALLOWED_HOSTS.
 */
const HOST = "hooks.example.test";
const allowAll = () => ({ allowed: true as const });
const message: ChannelMessage = { title: "Big invoice", body: "Invoice INV-1 for Acme was created.", linkUrl: "https://app.example.test/acme/sales/invoices/1", severity: "INFO", amountLine: "Total 1100.00 AUD" };

let hasOpenssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  hasOpenssl = false;
}

describe.skipIf(!hasOpenssl)("Slack provider over real TLS", () => {
  let dir: string;
  let certPem: string;
  let server: https.Server;
  let port: number;
  let mode: "ok" | "redirect" | "error";
  const seen: Array<{ method?: string; url?: string; host?: string; userAgent?: string; contentType?: string; body: string }> = [];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-slack-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`], { stdio: "ignore" });
    certPem = readFileSync(path.join(dir, "c.pem"), "utf8");
    mode = "ok";
    server = https.createServer({ key: readFileSync(path.join(dir, "k.pem"), "utf8"), cert: certPem }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, host: req.headers.host, userAgent: req.headers["user-agent"], contentType: req.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") });
        if (mode === "redirect") {
          res.writeHead(302, { Location: "https://169.254.169.254/latest/meta-data/" });
          res.end("moved");
        } else if (mode === "error") {
          res.writeHead(404);
          res.end("no_service");
        } else {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const URL_OK = `https://${HOST}/services/T0123ABCD/B0123ABCD/abcdEFGHijklMNOP`;
  const send = (url = URL_OK, includeAmounts = false, hosts: readonly string[] = [HOST]) =>
    sendSlackMessage(url, message, { includeAmounts }, { resolver: fakeResolver({ [HOST]: ["127.0.0.1"] }), classify: allowAll, transport: createHttpsTransport({ ca: certPem, classify: allowAll, port }) }, hosts);

  it("delivers a {text} POST with the right path, headers and body, verifying the certificate against the real host name", async () => {
    mode = "ok";
    seen.length = 0;
    const result = await send();
    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/services/T0123ABCD/B0123ABCD/abcdEFGHijklMNOP", host: `${HOST}:${port}`, contentType: "application/json", userAgent: "MoneyMatters-Integrations/1" });
    const payload = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["text"]);
    expect(payload.text).toContain("Invoice INV-1 for Acme was created.");
    expect(payload.text).not.toContain("1100"); // amounts off
    const withAmounts = await send(URL_OK, true);
    expect(withAmounts.ok).toBe(true);
    expect(JSON.parse(seen[1]!.body).text).toContain("Total 1100.00 AUD");
  });

  it("the production allowlist refuses this host outright: nothing is sent", async () => {
    seen.length = 0;
    const result = await send(URL_OK, false, SLACK_ALLOWED_HOSTS);
    expect(result).toMatchObject({ ok: false, errorClass: "ssrf_blocked" });
    expect(seen).toHaveLength(0);
  });

  it("never follows a redirect (not even to the metadata address): one request, a recorded failure", async () => {
    mode = "redirect";
    seen.length = 0;
    const result = await send();
    expect(result).toMatchObject({ ok: false, errorClass: "redirect", statusCode: 302 });
    expect(seen).toHaveLength(1);
  });

  it("an HTTP error is reported by status only", async () => {
    mode = "error";
    seen.length = 0;
    const result = await send();
    expect(result).toMatchObject({ ok: false, errorClass: "http_error", statusCode: 404, message: "Slack answered HTTP 404." });
  });

  it("an untrusted certificate is refused: TLS verification is never disabled", async () => {
    mode = "ok";
    seen.length = 0;
    const result = await sendSlackMessage(URL_OK, message, { includeAmounts: false }, { resolver: fakeResolver({ [HOST]: ["127.0.0.1"] }), classify: allowAll, transport: createHttpsTransport({ classify: allowAll, port }) }, [HOST]);
    expect(result).toMatchObject({ ok: false, errorClass: "tls" });
    expect(seen).toHaveLength(0);
  });
});
