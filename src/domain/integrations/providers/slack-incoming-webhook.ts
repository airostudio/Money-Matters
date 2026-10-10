import { z } from "zod";
import { sendWebhook, type OutboundDeps, type OutboundResult } from "@/domain/webhooks/outbound";
import { parseWebhookUrl, resolveAndVet, systemResolver, type UrlVerdict } from "@/domain/webhooks/url-guard";
import { classifyAddress } from "@/domain/webhooks/ip-classifier";
import type { ChannelMessage, IntegrationProvider, OperationResult, ProviderContext, ValidatedConfig } from "../provider";

/**
 * The one REAL provider: a Slack-compatible INCOMING WEBHOOK (docs/security.md section 19).
 *
 * The person supplies a webhook URL. That URL is a BEARER SECRET (anyone holding it can post to the channel), so it is
 * stored encrypted, never displayed back (only a masked tail) and never logged or audited.
 *
 * Defence in depth on the destination, applied at connect time AND on every send, in this order:
 *   1. a HOST ALLOWLIST (`SLACK_ALLOWED_HOSTS`, exact match, nothing else: `hooks.slack.com.evil.com`, `evilhooks.slack.com`,
 *      `slack.com`, IP literals, userinfo tricks and every other host are refused) plus a path shape (`/services/T/B/token`);
 *   2. the full SSRF guard of the webhook slice (https only, port 443, no credentials, no private / special address, every
 *      DNS answer vetted, the socket pinned to the vetted IP, no redirects, a timeout, a response cap).
 * The allowlist can only NARROW what the SSRF guard already allows. TLS verification is never disabled.
 *
 * Message format is Slack's documented simplest payload, `{ "text": "..." }`: plain text and one link back to the relevant
 * page. It carries no financial detail beyond what the notification itself holds, and amounts only when the connection's
 * "include amounts" toggle (off by default) is on. Slack's three control characters are escaped, so text can never
 * become a mention (`<!channel>`), a user group or a link.
 *
 * Microsoft Teams is deliberately NOT here: its supported incoming-webhook mechanism could not be verified offline.
 */
export const SLACK_PROVIDER_ID = "slack_incoming_webhook";
/** The ONLY hosts a Slack connection may send to. Exact match. */
export const SLACK_ALLOWED_HOSTS: readonly string[] = ["hooks.slack.com"];
export const SLACK_USER_AGENT = "MoneyMatters-Integrations/1";
export const MAX_SLACK_TEXT_CHARS = 3000;
const SLACK_PATH = /^\/services\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,128}$/;

export interface SlackConfig {
  webhookUrl: string;
  includeAmounts: boolean;
  channelLabel?: string;
}

export const slackConfigSchema = z
  .object({
    webhookUrl: z.string().min(1).max(512),
    includeAmounts: z.boolean().default(false),
    channelLabel: z.string().trim().max(60).optional(),
  })
  .strict();

export type SlackUrlVerdict = { ok: true; url: URL; hostname: string } | { ok: false; reason: string };

/** The destination check, pure and synchronous (no DNS): allowlist + path shape + the SSRF guard's URL layer. */
export function checkSlackUrl(raw: string, allowedHosts: readonly string[] = SLACK_ALLOWED_HOSTS): SlackUrlVerdict {
  const parsed: UrlVerdict = parseWebhookUrl(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.literalIp !== null || !allowedHosts.includes(parsed.hostname)) {
    return { ok: false, reason: `That is not a Slack incoming-webhook address. Use the URL Slack gave you (it starts with https://${allowedHosts[0] ?? "hooks.slack.com"}/services/).` };
  }
  if (!SLACK_PATH.test(parsed.url.pathname) || parsed.url.search !== "") {
    return { ok: false, reason: "That does not look like a Slack incoming-webhook URL (expected https://hooks.slack.com/services/T.../B.../...)." };
  }
  return { ok: true, url: parsed.url, hostname: parsed.hostname };
}

/** A rendering of the URL that identifies it without revealing it: the host and the last four characters of the token. */
export function maskSlackUrl(raw: string): string {
  const verdict = checkSlackUrl(raw);
  const tail = raw.trim().slice(-4);
  return verdict.ok ? `${verdict.hostname}/services/…${tail}` : `…${tail}`;
}

/** Escapes the three characters Slack treats as control characters, and strips line breaks from a single-line field. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function oneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

const SEVERITY_PREFIX: Record<ChannelMessage["severity"], string> = { INFO: "", ACTION: "[Action] ", WARNING: "[Warning] ", CRITICAL: "[Critical] " };

/**
 * Builds Slack's `{ text }` payload. Amounts appear ONLY when `includeAmounts` is true. The link is appended as Slack's
 * `<url|label>` form around OUR https URL only (the URL is validated to be https and free of `<>|` before use).
 */
export function buildSlackPayload(message: ChannelMessage, options: { includeAmounts: boolean }): { text: string } {
  const lines: string[] = [`*${escapeSlack(SEVERITY_PREFIX[message.severity] + oneLine(message.title))}*`];
  if (message.body) lines.push(escapeSlack(message.body.trim()));
  if (options.includeAmounts && message.amountLine) lines.push(escapeSlack(oneLine(message.amountLine)));
  if (message.linkUrl && /^https:\/\/[^\s<>|]+$/.test(message.linkUrl)) lines.push(`<${message.linkUrl}|Open in Money Matters>`);
  let text = lines.join("\n");
  if (text.length > MAX_SLACK_TEXT_CHARS) text = `${text.slice(0, MAX_SLACK_TEXT_CHARS - 1)}…`;
  return { text };
}

export const SLACK_TEST_MESSAGE: ChannelMessage = {
  title: "Money Matters test message",
  body: "This is a test from Money Matters. If you can read this, the connection works. Nothing else was sent.",
  linkUrl: null,
  severity: "INFO",
  amountLine: null,
};

function toOperation(result: OutboundResult): OperationResult {
  if (result.success) return { ok: true, message: "Slack accepted the message.", errorClass: null, statusCode: result.statusCode };
  const detail = result.errorClass === "http_error" && result.statusCode ? `Slack answered HTTP ${result.statusCode}.` : (result.errorMessage ?? "The message could not be sent.");
  return { ok: false, message: detail, errorClass: result.errorClass, statusCode: result.statusCode };
}

/**
 * Posts one message. The allowlist is re-applied here (a stored row is not trusted), then the shared SSRF-guarded client
 * does the rest. `allowedHosts` exists ONLY so a test can point the real TLS stack at a local server under a fake host
 * name; no production path passes it.
 */
export async function sendSlackMessage(
  webhookUrl: string,
  message: ChannelMessage,
  options: { includeAmounts: boolean },
  deps: OutboundDeps = {},
  allowedHosts: readonly string[] = SLACK_ALLOWED_HOSTS,
): Promise<OperationResult> {
  const verdict = checkSlackUrl(webhookUrl, allowedHosts);
  if (!verdict.ok) return { ok: false, message: verdict.reason, errorClass: "ssrf_blocked", statusCode: null };
  const result = await sendWebhook(
    {
      url: webhookUrl.trim(),
      headers: { "Content-Type": "application/json", "User-Agent": SLACK_USER_AGENT },
      body: JSON.stringify(buildSlackPayload(message, options)),
    },
    deps,
  );
  return toOperation(result);
}

export const slackIncomingWebhookProvider: IntegrationProvider<SlackConfig> = {
  id: SLACK_PROVIDER_ID,
  name: "Slack (incoming webhook)",
  category: "MESSAGING",
  description:
    "Posts short automation messages to a Slack channel through an incoming webhook URL that you create in Slack. Works with Slack-compatible services that use the same payload.",
  capabilities: ["send"],
  configSchema: slackConfigSchema,
  secretFields: ["webhookUrl"],

  validateConfig(input: unknown): ValidatedConfig<SlackConfig> {
    const parsed = slackConfigSchema.safeParse(input);
    if (!parsed.success) return { ok: false, message: "Enter the Slack incoming-webhook URL." };
    const verdict = checkSlackUrl(parsed.data.webhookUrl);
    if (!verdict.ok) return { ok: false, message: verdict.reason };
    const webhookUrl = parsed.data.webhookUrl.trim();
    const config: SlackConfig = { webhookUrl, includeAmounts: parsed.data.includeAmounts, channelLabel: parsed.data.channelLabel || undefined };
    return {
      ok: true,
      config,
      publicConfig: { includeAmounts: config.includeAmounts, channelLabel: config.channelLabel ?? null, maskedUrl: maskSlackUrl(webhookUrl) },
      secretConfig: { webhookUrl },
    };
  },

  /** Allowlist, URL guard and DNS vetting - no request is made to Slack. */
  async connect(ctx: ProviderContext<SlackConfig>, deps: OutboundDeps = {}): Promise<OperationResult> {
    const verdict = checkSlackUrl(ctx.config.webhookUrl);
    if (!verdict.ok) return { ok: false, message: verdict.reason, errorClass: "ssrf_blocked", statusCode: null };
    const parsed = parseWebhookUrl(ctx.config.webhookUrl);
    if (!parsed.ok) return { ok: false, message: parsed.reason, errorClass: "ssrf_blocked", statusCode: null };
    const vet = await resolveAndVet(parsed, deps.resolver ?? systemResolver, deps.classify ?? classifyAddress);
    if (!vet.ok) return { ok: false, message: `The address cannot be used (${vet.reason}).`, errorClass: vet.errorClass, statusCode: null };
    return { ok: true, message: "The address is acceptable. Send a test message to confirm it works.", errorClass: null, statusCode: null };
  },

  async testConnection(ctx: ProviderContext<SlackConfig>, deps: OutboundDeps = {}): Promise<OperationResult> {
    return sendSlackMessage(ctx.config.webhookUrl, SLACK_TEST_MESSAGE, { includeAmounts: false }, deps);
  },

  async disconnect(): Promise<void> {
    // A Slack incoming webhook has no server-side session to close; revoke the webhook in Slack itself if it should stop working there.
  },

  async send(ctx: ProviderContext<SlackConfig>, message: ChannelMessage, deps: OutboundDeps = {}): Promise<OperationResult> {
    return sendSlackMessage(ctx.config.webhookUrl, message, { includeAmounts: ctx.config.includeAmounts }, deps);
  },
};
