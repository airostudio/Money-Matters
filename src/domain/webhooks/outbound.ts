import https from "node:https";
import { isIP } from "node:net";
import { classifyAddress } from "./ip-classifier";
import { sanitiseError, sanitiseExcerpt } from "./sanitize";
import { parseWebhookUrl, resolveAndVet, systemResolver, WEBHOOK_PORT, type AddressClassifier, type ResolvedAddress, type Resolver } from "./url-guard";

/**
 * The guarded outbound HTTP client used for EVERY webhook delivery (docs/security.md section 16).
 *
 *   1. the URL is re-validated (https, port 443, no credentials, no private IP literal) - even though it was validated
 *      at subscription time, because a stored row is not trusted;
 *   2. the host is resolved and EVERY answer must be publicly routable;
 *   3. the TCP connection is made to the VALIDATED IP through a pinned `lookup`, so DNS cannot be re-resolved to an
 *      internal address between the check and the connect (the DNS-rebinding TOCTOU). TLS still verifies the
 *      certificate against the real host name (SNI + hostname check; verification is never disabled);
 *   4. redirects are NEVER followed - a 3xx is a failure that is recorded;
 *   5. a total timeout, a response read cap and a request size cap bound every call.
 *
 * Resolver and transport are injectable so tests run offline and can simulate hostile DNS, slow servers and huge bodies.
 */
export const DELIVERY_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 8 * 1024;
export const MAX_REQUEST_BYTES = 512 * 1024;
export const USER_AGENT = "MoneyMatters-Webhooks/1";

export interface DeliveryRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface TransportRequest {
  url: URL;
  hostname: string;
  /** The vetted address the socket must connect to. */
  address: ResolvedAddress;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface TransportResponse {
  status: number;
  /** At most `maxResponseBytes` of the body; the rest is discarded and the connection dropped. */
  bodyExcerpt: Buffer;
}

export class TransportError extends Error {
  constructor(
    public readonly errorClass: string,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface OutboundResult {
  success: boolean;
  statusCode: number | null;
  /** NULL for a 2xx. ssrf_blocked, dns, redirect, http_error, timeout, tls, connect, network, request_too_large, ... */
  errorClass: string | null;
  errorMessage: string | null;
  excerpt: string | null;
  durationMs: number;
}

export interface OutboundDeps {
  resolver?: Resolver;
  transport?: Transport;
  classify?: AddressClassifier;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const TLS_ERROR_CODES = /^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|ERR_OSSL)/;

function classifyNetworkError(error: unknown): { errorClass: string; message: string } {
  if (error instanceof TransportError) return { errorClass: error.errorClass, message: error.message };
  const code = (error as { code?: string }).code ?? "";
  const message = (error as Error).message ?? "network error";
  if (TLS_ERROR_CODES.test(code)) return { errorClass: "tls", message: `TLS error (${code})` };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { errorClass: "dns", message: `DNS lookup failed (${code})` };
  if (["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(code)) {
    return { errorClass: code === "ETIMEDOUT" ? "timeout" : "connect", message: `Connection failed (${code})` };
  }
  return { errorClass: "network", message };
}

/** The production transport: node:https with a pinned lookup. `tls` and `classify` exist for tests against a real local TLS server only. */
export function createHttpsTransport(options: { ca?: string | Buffer; classify?: AddressClassifier; port?: number } = {}): Transport {
  const classify = options.classify ?? classifyAddress;
  return (request) =>
    new Promise<TransportResponse>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const { url, hostname, address } = request;

      const pinnedLookup = (_name: string, lookupOptions: unknown, callback: (...args: unknown[]) => void) => {
        const cb = (typeof lookupOptions === "function" ? lookupOptions : callback) as (...args: unknown[]) => void;
        const opts = (typeof lookupOptions === "object" && lookupOptions !== null ? lookupOptions : {}) as { all?: boolean };
        // Belt and braces: the address is classified AGAIN at the moment the socket asks for it.
        const verdict = classify(address.address);
        if (!verdict.allowed) {
          cb(new TransportError("ssrf_blocked", `address not allowed (${verdict.reason})`));
          return;
        }
        if (opts.all) cb(null, [{ address: address.address, family: address.family }]);
        else cb(null, address.address, address.family);
      };

      const body = Buffer.from(request.body, "utf8");
      const req = https.request({
        protocol: "https:",
        host: hostname,
        port: options.port ?? WEBHOOK_PORT,
        method: "POST",
        path: `${url.pathname}${url.search}`,
        headers: { ...request.headers, "Content-Length": String(body.byteLength) },
        agent: false,
        lookup: pinnedLookup as never,
        servername: isIP(hostname) === 0 ? hostname : undefined,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(options.ca ? { ca: options.ca } : {}),
      });

      const timer = setTimeout(() => {
        finish(() => reject(new TransportError("timeout", `No complete response within ${Math.round(request.timeoutMs / 1000)}s`)));
        req.destroy();
      }, request.timeoutMs);

      req.on("error", (error) => finish(() => reject(error)));
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        const done = () =>
          finish(() => {
            resolve({ status: res.statusCode ?? 0, bodyExcerpt: Buffer.concat(chunks).subarray(0, request.maxResponseBytes) });
            res.destroy();
            req.destroy();
          });
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          const room = request.maxResponseBytes - received;
          if (room > 0) {
            const slice = chunk.subarray(0, room);
            chunks.push(slice);
            received += slice.byteLength;
          }
          // Cap reached: stop reading, drop the connection. The status line already told us the outcome.
          if (received >= request.maxResponseBytes) done();
        });
        res.on("end", done);
        res.on("error", (error) => finish(() => reject(error)));
        res.on("close", done);
      });
      req.end(body);
    });
}

/**
 * Sends one delivery. Never throws: every failure (blocked address, DNS, TLS, timeout, redirect, HTTP error) comes back as
 * a result with an `errorClass`, because the caller records it in the attempt log.
 */
export async function sendWebhook(request: DeliveryRequest, deps: OutboundDeps = {}): Promise<OutboundResult> {
  const started = Date.now();
  const elapsed = () => Math.max(0, Date.now() - started);
  const failure = (errorClass: string, message: string, extra: Partial<OutboundResult> = {}): OutboundResult => ({
    success: false,
    statusCode: null,
    errorClass,
    errorMessage: sanitiseError(message),
    excerpt: null,
    durationMs: elapsed(),
    ...extra,
  });

  try {
    if (Buffer.byteLength(request.body, "utf8") > MAX_REQUEST_BYTES) return failure("request_too_large", "The event payload exceeds the request size limit.");

    const verdict = parseWebhookUrl(request.url);
    if (!verdict.ok) return failure("ssrf_blocked", verdict.reason);

    const vet = await resolveAndVet(verdict, deps.resolver ?? systemResolver, deps.classify ?? classifyAddress);
    if (!vet.ok) return failure(vet.errorClass, vet.reason);
    const address = vet.addresses[0] as ResolvedAddress;

    const transport = deps.transport ?? createHttpsTransport();
    const maxResponseBytes = deps.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    const response = await transport({
      url: verdict.url,
      hostname: verdict.hostname,
      address,
      headers: request.headers,
      body: request.body,
      timeoutMs: deps.timeoutMs ?? DELIVERY_TIMEOUT_MS,
      maxResponseBytes,
    });
    const excerpt = sanitiseExcerpt(response.bodyExcerpt.subarray(0, maxResponseBytes));
    const base = { statusCode: response.status, excerpt, durationMs: elapsed() };

    if (response.status >= 200 && response.status < 300) return { success: true, errorClass: null, errorMessage: null, ...base };
    if (response.status >= 300 && response.status < 400) {
      return { success: false, errorClass: "redirect", errorMessage: `HTTP ${response.status}: redirects are not followed`, ...base };
    }
    return { success: false, errorClass: "http_error", errorMessage: `HTTP ${response.status}`, ...base };
  } catch (error) {
    const { errorClass, message } = classifyNetworkError(error);
    return failure(errorClass, message);
  }
}
