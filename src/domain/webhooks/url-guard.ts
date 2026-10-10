import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyAddress, type AddressVerdict } from "./ip-classifier";

/**
 * The SSRF guard's URL layer (docs/security.md section 16). ONE guard, used for BOTH subscription validation and every
 * delivery. It is defence in depth, not the only control: outbound requests originate from the serverless platform, so
 * the platform's own network egress rules remain the outer wall.
 *
 *  - `parseWebhookUrl`  pure, synchronous: https only, no credentials, port 443 only, bounded length, no fragment,
 *    no IP literal in a private/special range, no obviously internal host names.
 *  - `resolveAndVet`    resolves the host and refuses if ANY returned address is not publicly routable; returns the
 *    validated addresses so the transport can CONNECT TO THE VALIDATED IP (closing the DNS-rebinding TOCTOU window).
 */
export const MAX_WEBHOOK_URL_LENGTH = 2048;
export const WEBHOOK_PORT = 443;

/** Host-name suffixes that are never public, refused before any DNS lookup is spent on them. */
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".intranet", ".lan", ".corp"];

export type UrlVerdict =
  | { ok: true; url: URL; hostname: string; port: number; literalIp: string | null }
  | { ok: false; reason: string };

const fail = (reason: string): UrlVerdict => ({ ok: false, reason });

export function parseWebhookUrl(raw: string): UrlVerdict {
  if (typeof raw !== "string") return fail("The URL must be text.");
  const text = raw.trim();
  if (text.length === 0) return fail("Enter the URL that should receive events.");
  if (text.length > MAX_WEBHOOK_URL_LENGTH) return fail(`The URL is too long (at most ${MAX_WEBHOOK_URL_LENGTH} characters).`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(text)) return fail("The URL must not contain spaces or control characters.");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail("That is not a valid URL.");
  }
  if (url.protocol !== "https:") return fail("The URL must start with https:// - plain http is not allowed.");
  if (url.username !== "" || url.password !== "") return fail("The URL must not contain a username or password.");
  if (url.port !== "" && Number(url.port) !== WEBHOOK_PORT) return fail("Only the standard HTTPS port (443) is allowed.");
  if (url.hash !== "") return fail("The URL must not contain a #fragment.");

  let hostname = url.hostname.toLowerCase();
  if (hostname.endsWith(".") && hostname.length > 1) hostname = hostname.slice(0, -1);
  if (hostname === "") return fail("The URL has no host name.");

  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0) {
    const verdict = classifyAddress(bare);
    if (!verdict.allowed) return fail(`That address is not allowed (${verdict.reason}). Use a public host name.`);
    return { ok: true, url, hostname: bare, port: WEBHOOK_PORT, literalIp: bare };
  }
  // WHATWG URL already canonicalises hex/octal/short IPv4 spellings to dotted decimal, so anything left that LOOKS
  // numeric but is not a valid IP is refused rather than handed to a resolver.
  if (/^[0-9.]+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) return fail("That host name looks like an IP address but is not a valid one.");
  if (hostname === "localhost" || INTERNAL_SUFFIXES.some((s) => hostname.endsWith(s))) return fail("Internal host names are not allowed.");
  if (!hostname.includes(".")) return fail("Use a fully qualified public host name (for example hooks.example.com).");
  return { ok: true, url, hostname, port: WEBHOOK_PORT, literalIp: null };
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** The injectable DNS resolver: returns EVERY address for a host. Tests supply hostile answers; production uses the OS resolver. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

export type VetOutcome =
  | { ok: true; addresses: ResolvedAddress[] }
  | { ok: false; errorClass: "ssrf_blocked" | "dns"; reason: string };

export type AddressClassifier = (address: string) => AddressVerdict;

/**
 * Resolves `hostname` and vets EVERY answer. One private address among public ones refuses the whole host (an attacker
 * controlling DNS can interleave them). An IP-literal host is classified directly with no lookup. Never throws.
 */
export async function resolveAndVet(
  verdict: Extract<UrlVerdict, { ok: true }>,
  resolver: Resolver = systemResolver,
  classify: AddressClassifier = classifyAddress,
): Promise<VetOutcome> {
  if (verdict.literalIp) {
    const v = classify(verdict.literalIp);
    return v.allowed
      ? { ok: true, addresses: [{ address: verdict.literalIp, family: isIP(verdict.literalIp) === 6 ? 6 : 4 }] }
      : { ok: false, errorClass: "ssrf_blocked", reason: v.reason };
  }
  let answers: ResolvedAddress[];
  try {
    answers = await resolver(verdict.hostname);
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { ok: false, errorClass: "dns", reason: code ? `DNS lookup failed (${code})` : "DNS lookup failed" };
  }
  if (answers.length === 0) return { ok: false, errorClass: "dns", reason: "DNS returned no addresses" };
  for (const answer of answers) {
    const v = classify(answer.address);
    if (!v.allowed) {
      return { ok: false, errorClass: "ssrf_blocked", reason: `resolves to a non-public address (${v.reason})` };
    }
  }
  return { ok: true, addresses: answers };
}
