import { describe, expect, it } from "vitest";
import { EmailService, readEmailConfig, EMAIL_NOT_CONFIGURED_MESSAGE } from "@/domain/email/email-service";
import type { Transport, TransportRequest } from "@/domain/webhooks/outbound";

const ENV = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "test-key-not-real", EMAIL_FROM: "Acme <billing@mail.example.com>" };
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];

function fake(status: number, body: unknown) {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (req) => {
    calls.push(req);
    return { status, bodyExcerpt: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { calls, transport };
}

describe("readEmailConfig", () => {
  it("is inert unless all three variables are set and valid", () => {
    expect(readEmailConfig({})).toBeNull();
    expect(readEmailConfig({ ...ENV, EMAIL_PROVIDER: "smtp" })).toBeNull();
    expect(readEmailConfig({ ...ENV, RESEND_API_KEY: "" })).toBeNull();
    expect(readEmailConfig({ ...ENV, EMAIL_FROM: "not an address" })).toBeNull();
    expect(readEmailConfig({ ...ENV, EMAIL_FROM: "a@b.co\r\nBcc: x@y.z" })).toBeNull();
    expect(readEmailConfig(ENV)).not.toBeNull();
  });
});

describe("EmailService.send", () => {
  it("fails closed and sends nothing when not configured", async () => {
    const f = fake(200, { id: "x" });
    const r = await EmailService.send({ to: "a@b.co", subject: "Hi", text: "t" }, { env: {}, transport: f.transport, resolver: publicResolver });
    expect(r).toEqual({ ok: false, errorClass: "not_configured", message: EMAIL_NOT_CONFIGURED_MESSAGE });
    expect(f.calls).toHaveLength(0);
  });

  it("posts the documented request to api.resend.com only", async () => {
    const f = fake(200, { id: "49a3999c" });
    const r = await EmailService.send(
      { to: ["a@b.co"], subject: "Hello", html: "<p>x</p>", text: "x", idempotencyKey: "k-1" },
      { env: ENV, transport: f.transport, resolver: publicResolver },
    );
    expect(r).toEqual({ ok: true, id: "49a3999c" });
    const req = f.calls[0]!;
    expect(req.url.href).toBe("https://api.resend.com/emails");
    expect(req.hostname).toBe("api.resend.com");
    expect(req.headers.Authorization).toBe("Bearer test-key-not-real");
    expect(req.headers["Idempotency-Key"]).toBe("k-1");
    expect(JSON.parse(req.body)).toEqual({ from: ENV.EMAIL_FROM, to: ["a@b.co"], subject: "Hello", html: "<p>x</p>", text: "x" });
  });

  it("refuses when DNS resolves to a private address and never calls the transport", async () => {
    const f = fake(200, { id: "x" });
    const r = await EmailService.send(
      { to: "a@b.co", subject: "Hi", text: "t" },
      { env: ENV, transport: f.transport, resolver: async () => [{ address: "10.0.0.5", family: 4 as const }] },
    );
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("validates recipients, subject and header injection", async () => {
    const f = fake(200, { id: "x" });
    const d = { env: ENV, transport: f.transport, resolver: publicResolver };
    expect((await EmailService.send({ to: "nope", subject: "s", text: "t" }, d)).ok).toBe(false);
    expect((await EmailService.send({ to: "a@b.co", subject: "s\nBcc: x@y.z", text: "t" }, d)).ok).toBe(false);
    expect((await EmailService.send({ to: "a@b.co", subject: "s" }, d)).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("surfaces only the provider error name, never its text, the key or the body", async () => {
    const f = fake(422, { name: "validation_error", message: "secret-body-text a@b.co", statusCode: 422 });
    const r = await EmailService.send(
      { to: "a@b.co", subject: "Link", text: "https://x.example/reset?token=SECRETTOKEN" },
      { env: ENV, transport: f.transport, resolver: publicResolver },
    );
    expect(r.ok).toBe(false);
    const json = JSON.stringify(r);
    expect(json).toContain("validation_error");
    expect(json).not.toContain("secret-body-text");
    expect(json).not.toContain("SECRETTOKEN");
    expect(json).not.toContain("test-key-not-real");
  });

  it("does not follow redirects and survives transport failures", async () => {
    const redirect = await EmailService.send({ to: "a@b.co", subject: "s", text: "t" }, { env: ENV, transport: fake(302, "").transport, resolver: publicResolver });
    expect(redirect).toMatchObject({ ok: false, errorClass: "redirect" });
    const boom: Transport = async () => {
      throw Object.assign(new Error("boom test-key-not-real"), { code: "ECONNRESET" });
    };
    const r = await EmailService.send({ to: "a@b.co", subject: "s", text: "t" }, { env: ENV, transport: boom, resolver: publicResolver });
    expect(r).toMatchObject({ ok: false, errorClass: "network" });
    expect(JSON.stringify(r)).not.toContain("test-key-not-real");
  });
});
