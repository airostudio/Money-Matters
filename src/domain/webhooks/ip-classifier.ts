import { isIP } from "node:net";

/**
 * The IP classifier behind the outbound SSRF guard (docs/security.md section 16). DEFAULT-DENY: an address is allowed
 * only when it is a globally routable unicast address; everything else - loopback, private, link-local (including the
 * cloud metadata address 169.254.169.254), CGNAT, unspecified, multicast, reserved, documentation, benchmarking,
 * IPv6 ULA / link-local / site-local, Teredo, and every IPv4-in-IPv6 form (mapped, compatible, NAT64, 6to4) whose
 * embedded IPv4 address is itself not public - is refused.
 *
 * Pure and table-tested (src/tests/unit/webhooks/ip-classifier.test.ts). Input must be a literal IP; hostnames are
 * resolved by the caller and EVERY resolved address is classified.
 */
export type AddressVerdict = { allowed: true } | { allowed: false; reason: string };

const deny = (reason: string): AddressVerdict => ({ allowed: false, reason });
const ALLOW: AddressVerdict = { allowed: true };

/** [network as 32-bit unsigned, prefix length, reason]. Everything not listed here (and not in 0.0.0.0/0 reserved space) is public. */
const V4_BLOCKS: ReadonlyArray<readonly [string, number, string]> = [
  ["0.0.0.0", 8, "unspecified / 'this network' (0.0.0.0/8)"],
  ["10.0.0.0", 8, "private (10.0.0.0/8)"],
  ["100.64.0.0", 10, "carrier-grade NAT (100.64.0.0/10)"],
  ["127.0.0.0", 8, "loopback (127.0.0.0/8)"],
  ["169.254.0.0", 16, "link-local / cloud metadata (169.254.0.0/16)"],
  ["172.16.0.0", 12, "private (172.16.0.0/12)"],
  ["192.0.0.0", 24, "IETF protocol assignments (192.0.0.0/24)"],
  ["192.0.2.0", 24, "documentation (192.0.2.0/24)"],
  ["192.88.99.0", 24, "deprecated 6to4 relay anycast (192.88.99.0/24)"],
  ["192.168.0.0", 16, "private (192.168.0.0/16)"],
  ["198.18.0.0", 15, "benchmarking (198.18.0.0/15)"],
  ["198.51.100.0", 24, "documentation (198.51.100.0/24)"],
  ["203.0.113.0", 24, "documentation (203.0.113.0/24)"],
  ["224.0.0.0", 4, "multicast (224.0.0.0/4)"],
  ["240.0.0.0", 4, "reserved / broadcast (240.0.0.0/4)"],
];

/** Parses strict dotted-quad IPv4 (four decimal octets, no leading zeros beyond a single "0", no hex/octal/short forms). */
export function parseIPv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function inV4Block(value: number, network: string, prefix: number): boolean {
  const base = parseIPv4(network) as number;
  const size = 2 ** (32 - prefix);
  return value >= base && value < base + size;
}

export function classifyIPv4(text: string): AddressVerdict {
  const value = parseIPv4(text);
  if (value === null) return deny("not a valid IPv4 address");
  for (const [network, prefix, reason] of V4_BLOCKS) {
    if (inV4Block(value, network, prefix)) return deny(reason);
  }
  return ALLOW;
}

/** Expands an IPv6 literal to eight 16-bit groups. Handles "::" and an embedded dotted IPv4 tail; rejects zone ids. */
export function parseIPv6(text: string): number[] | null {
  if (text.includes("%") || text.includes("[") || text.includes("]")) return null;
  let working = text;
  // Embedded IPv4 tail ("::ffff:1.2.3.4") becomes two hex groups.
  const lastColon = working.lastIndexOf(":");
  if (lastColon !== -1 && working.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(working.slice(lastColon + 1));
    if (v4 === null) return null;
    working = `${working.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = working.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0] ?? "");
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseGroups(halves[1] ?? "");
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

const g = (groups: number[], i: number) => groups[i] as number;

function embeddedV4(hi: number, lo: number): string {
  return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
}

export function classifyIPv6(text: string): AddressVerdict {
  const groups = parseIPv6(text);
  if (!groups) return deny("not a valid IPv6 address");

  const allZeroUpTo = (n: number) => groups.slice(0, n).every((x) => x === 0);

  // ::/8 is reserved by IETF as a whole. Within it, the IPv4-mapped block (::ffff:a.b.c.d) is judged by its embedded IPv4.
  if (allZeroUpTo(5) && g(groups, 5) === 0xffff) {
    const v4 = classifyIPv4(embeddedV4(g(groups, 6), g(groups, 7)));
    return v4.allowed ? ALLOW : deny(`IPv4-mapped IPv6 address of a non-public IPv4 address (${v4.reason})`);
  }
  if (allZeroUpTo(4) && g(groups, 4) === 0xffff && g(groups, 5) === 0) {
    // ::ffff:0:a.b.c.d is IPv4-translated (SIIT, RFC 2765) - same rule as mapped.
    const v4 = classifyIPv4(embeddedV4(g(groups, 6), g(groups, 7)));
    return v4.allowed ? ALLOW : deny(`IPv4-translated IPv6 address of a non-public IPv4 address (${v4.reason})`);
  }
  if (allZeroUpTo(8)) return deny("unspecified (::)");
  if (allZeroUpTo(7) && g(groups, 7) === 1) return deny("loopback (::1)");
  if (allZeroUpTo(6)) {
    // Deprecated IPv4-compatible form ::a.b.c.d.
    const v4 = classifyIPv4(embeddedV4(g(groups, 6), g(groups, 7)));
    return deny(`IPv4-compatible IPv6 address (deprecated; embedded ${v4.allowed ? "public" : v4.reason} IPv4)`);
  }
  const first = g(groups, 0);
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address in the last 32 bits. (It sits numerically inside ::/8, so it
  // must be recognised BEFORE the blanket ::/8 refusal below.)
  if (first === 0x64 && g(groups, 1) === 0xff9b && groups.slice(2, 6).every((x) => x === 0)) {
    const v4 = classifyIPv4(embeddedV4(g(groups, 6), g(groups, 7)));
    return v4.allowed ? ALLOW : deny(`NAT64 address of a non-public IPv4 address (${v4.reason})`);
  }
  if ((first & 0xff00) === 0) return deny("reserved (::/8)");

  if ((first & 0xfe00) === 0xfc00) return deny("unique local address (fc00::/7)");
  if ((first & 0xffc0) === 0xfe80) return deny("link-local (fe80::/10)");
  if ((first & 0xffc0) === 0xfec0) return deny("deprecated site-local (fec0::/10)");
  if ((first & 0xff00) === 0xff00) return deny("multicast (ff00::/8)");

  // 6to4 (2002::/16) embeds the IPv4 address in bits 16..47.
  if (first === 0x2002) {
    const v4 = classifyIPv4(embeddedV4(g(groups, 1), g(groups, 2)));
    return v4.allowed ? ALLOW : deny(`6to4 address of a non-public IPv4 address (${v4.reason})`);
  }
  if (first === 0x2001 && g(groups, 1) === 0) return deny("Teredo (2001::/32)");
  if (first === 0x2001 && g(groups, 1) === 0x0db8) return deny("documentation (2001:db8::/32)");
  if (first === 0x2001 && g(groups, 1) < 0x0200) return deny("IETF protocol assignments (2001::/23)");
  if (first === 0x3fff && (g(groups, 1) & 0xf000) === 0) return deny("documentation (3fff::/20)");
  if (first === 0x0100 && g(groups, 1) === 0 && g(groups, 2) === 0 && g(groups, 3) === 0) return deny("discard-only (100::/64)");
  if (first === 0x5f00) return deny("SRv6 segment identifiers (5f00::/16)");

  // Default deny: only global unicast 2000::/3 remains allowed.
  if ((first & 0xe000) !== 0x2000) return deny("outside global unicast space (not 2000::/3)");
  return ALLOW;
}

/** Classifies a literal IPv4 or IPv6 address (no brackets). Anything that is not a literal IP is denied. */
export function classifyAddress(address: string): AddressVerdict {
  const kind = isIP(address);
  if (kind === 4) return classifyIPv4(address);
  if (kind === 6) return classifyIPv6(address);
  // net.isIP rejects zone ids and malformed text; our own parsers must agree.
  return deny("not a literal IP address");
}
