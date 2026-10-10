import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import tls from "node:tls";
import { createHttpsTransport, sendWebhook } from "@/domain/webhooks/outbound";
import { fakeResolver } from "../../helpers/webhooks";

/**
 * The REAL transport (node:https with the pinned lookup) against a real local TLS server. Offline and deterministic: the
 * host name "hooks.example.test" does not exist in DNS at all, so a successful connection proves the socket went to the
 * address the guard validated and not to anything the system resolver would say. The test classifier allows loopback
 * here ONLY because the server is on loopback; production uses the default classifier, which never would.
 */
const allowAll = () => ({ allowed: true as const });
const HOST = "hooks.example.test";

let hasOpenssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  hasOpenssl = false;
}

describe.skipIf(!hasOpenssl)("real HTTPS transport", () => {
  let dir: string;
  let keyPem: string;
  let certPem: string;
  let server: https.Server;
  let port: number;
  let seen: Array<{ url: string; host: string | undefined; servername: string | undefined; body: string; signature: string | undefined }>;
  let mode: "ok" | "redirect" | "huge" | "hang" | "error500";
  let servernames: string[];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-webhook-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`], { stdio: "ignore" });
    keyPem = readFileSync(path.join(dir, "k.pem"), "utf8");
    certPem = readFileSync(path.join(dir, "c.pem"), "utf8");
    seen = [];
    servernames = [];
    mode = "ok";
    server = https.createServer(
      {
        key: keyPem,
        cert: certPem,
        SNICallback: (servername, cb) => {
          servernames.push(servername);
          cb(null, tls.createSecureContext({ key: keyPem, cert: certPem }));
        },
      },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          seen.push({ url: req.url ?? "", host: req.headers.host, servername: servernames[servernames.length - 1], body: Buffer.concat(chunks).toString("utf8"), signature: req.headers["mm-signature"] as string | undefined });
          if (mode === "redirect") {
            res.writeHead(302, { Location: "https://169.254.169.254/latest/meta-data/" });
            res.end("moved");
          } else if (mode === "huge") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            const chunk = Buffer.alloc(64 * 1024, 0x41);
            let sent = 0;
            const write = () => {
              while (sent < 50 * 1024 * 1024) {
                sent += chunk.length;
                if (!res.write(chunk)) {
                  res.once("drain", write);
                  return;
                }
              }
              res.end();
            };
            write();
          } else if (mode === "hang") {
            // never answers
          } else if (mode === "error500") {
            res.writeHead(500);
            res.end("internal\u0000error");
          } else {
            res.writeHead(200);
            res.end("received");
          }
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const send = (over: { url?: string; timeoutMs?: number; ca?: string | undefined } = {}) =>
    sendWebhook(
      { url: over.url ?? `https://${HOST}/hook?x=1`, headers: { "Content-Type": "application/json", "Mm-Signature": "t=1,v1=abc" }, body: '{"a":1}' },
      {
        resolver: fakeResolver({ [HOST]: ["127.0.0.1"], "other.example.test": ["127.0.0.1"] }),
        classify: allowAll,
        transport: createHttpsTransport({ ca: "ca" in over ? over.ca : certPem, classify: allowAll, port }),
        timeoutMs: over.timeoutMs,
      },
    );

  it("connects to the vetted address (the host name is not resolvable), with the right SNI, Host header, path, body and headers", async () => {
    mode = "ok";
    seen.length = 0;
    const result = await send();
    expect(result).toMatchObject({ success: true, statusCode: 200, excerpt: "received" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "/hook?x=1", host: `${HOST}:${port}`, body: '{"a":1}', signature: "t=1,v1=abc" });
    expect(servernames).toContain(HOST);
  });

  it("verifies the certificate against the REAL host name: a valid chain for a different name is refused", async () => {
    mode = "ok";
    seen.length = 0;
    const result = await send({ url: "https://other.example.test/hook" });
    expect(result).toMatchObject({ success: false, errorClass: "tls", statusCode: null });
    expect(seen).toHaveLength(0); // the request was never sent over an unverified connection
  });

  it("refuses an untrusted (self-signed, not in the CA set) certificate: verification is never disabled", async () => {
    mode = "ok";
    seen.length = 0;
    const result = await send({ ca: undefined });
    expect(result).toMatchObject({ success: false, errorClass: "tls" });
    expect(seen).toHaveLength(0);
  });

  it("does not follow a redirect to the metadata address: one request, recorded as a redirect failure", async () => {
    mode = "redirect";
    seen.length = 0;
    const result = await send();
    expect(result).toMatchObject({ success: false, errorClass: "redirect", statusCode: 302 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.host).toBe(`${HOST}:${port}`);
  });

  it("caps a 50 MB response: returns promptly with a short, sanitised excerpt", async () => {
    mode = "huge";
    const started = Date.now();
    const result = await send();
    expect(result.success).toBe(true);
    expect(result.excerpt!.length).toBeLessThanOrEqual(1000);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("times out a server that never answers", async () => {
    mode = "hang";
    const started = Date.now();
    const result = await send({ timeoutMs: 400 });
    expect(result).toMatchObject({ success: false, errorClass: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("records a 500 with a control-stripped excerpt", async () => {
    mode = "error500";
    const result = await send();
    expect(result).toMatchObject({ success: false, errorClass: "http_error", statusCode: 500, excerpt: "internal error" });
  });

  it("with the DEFAULT classifier the same loopback server is refused before any connection is attempted", async () => {
    mode = "ok";
    seen.length = 0;
    const result = await sendWebhook(
      { url: `https://${HOST}/hook`, headers: {}, body: "{}" },
      { resolver: fakeResolver({ [HOST]: ["127.0.0.1"] }), transport: createHttpsTransport({ ca: certPem, port }) },
    );
    expect(result).toMatchObject({ success: false, errorClass: "ssrf_blocked" });
    expect(seen).toHaveLength(0);
  });
});
