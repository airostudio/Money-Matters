import { classifyAddress } from "@/domain/webhooks/ip-classifier";
import {
  createHttpsTransport,
  TransportError,
  type Transport,
} from "@/domain/webhooks/outbound";
import {
  parseWebhookUrl,
  resolveAndVet,
  systemResolver,
  type AddressClassifier,
  type ResolvedAddress,
  type Resolver,
} from "@/domain/webhooks/url-guard";

/**
 * A tiny, reusable transactional-email sender (Resend). Nothing in the product calls it yet; it exists so
 * notifications, invoice sending and similar can reuse ONE guarded client later.
 *
 * Request shape (verified against Resend's documentation, see docs/security.md "Email"): POST https://api.resend.com/emails,
 * `Authorization: Bearer <key>`, JSON body { from, to, subject, html, text }, optional `Idempotency-Key` header, success body
 * { id }, error body { name, message, statusCode }.
 *
 * Discipline (same as the webhook client): ONE fixed host (api.resend.com) on https port 443, resolved and vetted so
 * the socket connects to a validated public address, redirects never followed, timeout, response-size cap.
 *
 * FAILS CLOSED: unless EMAIL_PROVIDER=resend AND RESEND_API_KEY AND EMAIL_FROM are all set and valid, `send` sends nothing and
 * returns { ok: false, errorClass: "not_configured" }. Callers show `EMAIL_NOT_CONFIGURED_MESSAGE`.
 *
 * NEVER logged or returned: the API key, the message body, recipients' addresses in error text. Subject/body may contain
 * one-time links, so they are not echoed anywhere.
 */
export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const RESEND_HOST = "api.resend.com";
export const EMAIL_TIMEOUT_MS = 10_000;
export const EMAIL_MAX_RESPONSE_BYTES = 8 * 1024;
export const EMAIL_MAX_RECIPIENTS = 50;
export const EMAIL_MAX_BODY_BYTES = 1024 * 1024;
export const EMAIL_NOT_CONFIGURED_MESSAGE =
  "Email is not configured for this installation (the owner must set EMAIL_PROVIDER, RESEND_API_KEY and EMAIL_FROM).";

export interface EmailConfig {
  apiKey: string;
  from: string;
}

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const FROM =
  /^(?:[^<>\r\n"]{1,100}\s)?<[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+>$|^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** Reads the three variables; null (inert) unless all are present and well formed. Never throws. */
export function readEmailConfig(env: Record<string, string | undefined> = process.env): EmailConfig | null {
  if ((env.EMAIL_PROVIDER ?? "").trim().toLowerCase() !== "resend") return null;
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  const from = (env.EMAIL_FROM ?? "").trim();
  if (apiKey === "" || /[\s\r\n]/.test(apiKey)) return null;
  if (from === "" || !FROM.test(from)) return null;
  return { apiKey, from };
}

export function isEmailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return readEmailConfig(env) !== null;
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  /** Unique per logical send (<= 256 chars); Resend de-duplicates repeats for 24 hours. */
  idempotencyKey?: string;
}

export type EmailResult =
  | { ok: true; id: string | null }
  | { ok: false; errorClass: string; message: string };

export interface EmailDeps {
  env?: Record<string, string | undefined>;
  transport?: Transport;
  resolver?: Resolver;
  classify?: AddressClassifier;
  timeoutMs?: number;
}

const fail = (errorClass: string, message: string): EmailResult => ({ ok: false, errorClass, message });

function validateMessage(message: EmailMessage): { ok: true; to: string[] } | { ok: false; reason: string } {
  const to = (Array.isArray(message.to) ? message.to : [message.to]).map((a) => String(a).trim());
  if (to.length === 0 || to.length > EMAIL_MAX_RECIPIENTS) {
    return { ok: false, reason: `Between 1 and ${EMAIL_MAX_RECIPIENTS} recipients are required.` };
  }
  if (to.some((a) => !ADDRESS.test(a) || a.length > 254)) return { ok: false, reason: "A recipient address is not valid." };
  if (
    typeof message.subject !== "string" ||
    message.subject.trim() === "" ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(message.subject) ||
    message.subject.length > 300
  ) {
    return { ok: false, reason: "The subject is required, must be one line and at most 300 characters." };
  }
  if (!message.html && !message.text) return { ok: false, reason: "A message needs an html or text body." };
  if (Buffer.byteLength(`${message.html ?? ""}${message.text ?? ""}`, "utf8") > EMAIL_MAX_BODY_BYTES) {
    return { ok: false, reason: "The message is too large." };
  }
  if (
    message.idempotencyKey !== undefined &&
    (message.idempotencyKey.length === 0 || message.idempotencyKey.length > 256 || /[\r\n]/.test(message.idempotencyKey))
  ) {
    return { ok: false, reason: "The idempotency key must be 1-256 characters on one line." };
  }
  return { ok: true, to };
}

export const EmailService = {
  isConfigured: isEmailConfigured,

  /** Sends one message. Never throws; every failure is a result with an `errorClass` and a message free of secrets and body text. */
  async send(message: EmailMessage, deps: EmailDeps = {}): Promise<EmailResult> {
    const config = readEmailConfig(deps.env ?? process.env);
    if (!config) return fail("not_configured", EMAIL_NOT_CONFIGURED_MESSAGE);

    const valid = validateMessage(message);
    if (!valid.ok) return fail("invalid_message", valid.reason);

    try {
      // Re-vetted on every send: the URL is a constant, but the guard also pins DNS answers to public addresses.
      const verdict = parseWebhookUrl(RESEND_ENDPOINT);
      if (!verdict.ok || verdict.hostname !== RESEND_HOST) return fail("ssrf_blocked", "The email endpoint is not allowed.");
      const vet = await resolveAndVet(verdict, deps.resolver ?? systemResolver, deps.classify ?? classifyAddress);
      if (!vet.ok) return fail(vet.errorClass, "The email service could not be reached safely.");
      const address = vet.addresses[0] as ResolvedAddress;

      const body = JSON.stringify({
        from: config.from,
        to: valid.to,
        subject: message.subject,
        ...(message.html ? { html: message.html } : {}),
        ...(message.text ? { text: message.text } : {}),
      });
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "MoneyMatters-Email/1",
        ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
      };

      const transport = deps.transport ?? createHttpsTransport();
      const response = await transport({
        url: verdict.url,
        hostname: verdict.hostname,
        address,
        headers,
        body,
        timeoutMs: deps.timeoutMs ?? EMAIL_TIMEOUT_MS,
        maxResponseBytes: EMAIL_MAX_RESPONSE_BYTES,
      });

      const text = response.bodyExcerpt.toString("utf8");
      if (response.status >= 200 && response.status < 300) {
        let id: string | null = null;
        try {
          const parsed = JSON.parse(text) as { id?: unknown };
          if (typeof parsed.id === "string") id = parsed.id.slice(0, 100);
        } catch {
          /* a 2xx without a readable id is still accepted */
        }
        return { ok: true, id };
      }
      if (response.status >= 300 && response.status < 400) {
        return fail("redirect", `The email service answered HTTP ${response.status}; redirects are not followed.`);
      }
      // Only the provider's short error NAME is surfaced (e.g. validation_error), never its free text, which may echo input.
      let name = "http_error";
      try {
        const parsed = JSON.parse(text) as { name?: unknown };
        if (typeof parsed.name === "string" && /^[a-z_]{1,60}$/.test(parsed.name)) name = parsed.name;
      } catch {
        /* keep the generic class */
      }
      return fail(name, `The email service refused the message (HTTP ${response.status}, ${name}).`);
    } catch (error) {
      if (error instanceof TransportError) return fail(error.errorClass, "The email service could not be reached.");
      const code = (error as { code?: string }).code;
      return fail("network", code ? `The email service could not be reached (${code}).` : "The email service could not be reached.");
    }
  },
};
