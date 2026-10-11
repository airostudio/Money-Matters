import { createHmac } from "node:crypto";

/**
 * What the sign-in security code knows about the caller, reduced to the least that is useful and never stored raw
 * (docs/security.md section 22):
 *  - the client address is kept only as a keyed HMAC (`ipHash`, the per-address throttle key) and as a keyed HMAC of its
 *    network prefix (/24 IPv4, /48 IPv6: `ipPrefixHash`, used only to recognise a "new location");
 *  - the user agent is reduced to a coarse family ("Chrome on Windows");
 *  - emails are keyed HMACs, so the throttle and event tables hold no address that can be read back.
 * The HMAC key is derived from NEXTAUTH_SECRET, so a database dump alone cannot be used to test guessed addresses.
 */
export interface RequestContext {
  /** Raw address as the platform reported it; used in memory only, never persisted. */
  ip: string;
  userAgent: string;
}

export const UNKNOWN_CONTEXT: RequestContext = { ip: "unknown", userAgent: "" };

const FALLBACK_SECRET = "mm-login-security-unconfigured-secret";

export function keyedHash(namespace: string, value: string, secret: string | undefined = process.env.NEXTAUTH_SECRET): string {
  return createHmac("sha256", secret || FALLBACK_SECRET)
    .update(`mm-auth-hash:v1:${namespace}:${value}`)
    .digest("hex");
}

/** Throttle / event key for an email address. `email` must already be normalised (normalizeEmail). */
export function emailHash(email: string): string {
  return keyedHash("email", email);
}

export function ipHash(ip: string): string {
  return keyedHash("ip", ip);
}

/** The network an address belongs to: /24 for IPv4, /48 for IPv6 (anything unparseable is its own bucket). */
export function ipPrefix(ip: string): string {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(":")) {
    const groups = ip.toLowerCase().split("::")[0]!.split(":").filter((g) => g !== "");
    return `${groups.slice(0, 3).join(":")}::/48`;
  }
  return ip.slice(0, 64);
}

export function ipPrefixHash(ip: string): string {
  return keyedHash("ip-prefix", ipPrefix(ip));
}

/** "Chrome on Windows", "Safari on iOS", "Firefox on Linux", "Other". Deliberately coarse; never the full string. */
export function userAgentFamily(userAgent: string): string {
  const ua = userAgent.slice(0, 512);
  if (!ua) return "Unknown";
  let browser = "Other";
  if (/\bEdg(e|A|iOS)?\//.test(ua)) browser = "Edge";
  else if (/\bOPR\/|\bOpera\b/.test(ua)) browser = "Opera";
  else if (/\bFirefox\/|\bFxiOS\//.test(ua)) browser = "Firefox";
  else if (/\bChrome\/|\bCriOS\//.test(ua)) browser = "Chrome";
  else if (/\bSafari\//.test(ua)) browser = "Safari";
  else if (/^curl\//i.test(ua)) browser = "curl";
  let os = "";
  if (/\bWindows\b/.test(ua)) os = "Windows";
  else if (/\bAndroid\b/.test(ua)) os = "Android";
  else if (/\biPhone\b|\biPad\b|\biOS\b/.test(ua)) os = "iOS";
  else if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) os = "macOS";
  else if (/\bCrOS\b/.test(ua)) os = "ChromeOS";
  else if (/\bLinux\b/.test(ua)) os = "Linux";
  return os ? `${browser} on ${os}` : browser;
}

type HeaderBag = Headers | Record<string, string | string[] | undefined> | undefined | null;

function header(headers: HeaderBag, name: string): string {
  if (!headers) return "";
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? "";
  const bag = headers as Record<string, string | string[] | undefined>;
  const hit = bag[name] ?? bag[name.toLowerCase()];
  return Array.isArray(hit) ? (hit[0] ?? "") : (hit ?? "");
}

/**
 * The caller's address and user agent from request headers (a Headers object, or NextAuth's plain header record). The
 * address is the first hop of X-Forwarded-For (what a platform proxy sets), else X-Real-IP. On Vercel the platform
 * overwrites X-Forwarded-For, so a client cannot choose it; behind any other proxy that is not guaranteed, which is why
 * the PER-ACCOUNT lockout (not keyed on the address) is the control that does not depend on this header.
 */
export function requestContextFromHeaders(headers: HeaderBag): RequestContext {
  const forwarded = header(headers, "x-forwarded-for").split(",")[0]?.trim();
  const ip = (forwarded || header(headers, "x-real-ip").trim() || "unknown").slice(0, 64);
  return { ip, userAgent: header(headers, "user-agent").slice(0, 512) };
}
