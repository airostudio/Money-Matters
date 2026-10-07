import { describe, expect, it } from "vitest";
import { classifyAddress, parseIPv4, parseIPv6 } from "@/domain/webhooks/ip-classifier";

/**
 * The SSRF classifier (docs/security.md section 16): default-deny, table-driven. Every refused range appears at both edges
 * and in the middle; public addresses and the boundaries just outside each range are allowed.
 */
const BLOCKED: Array<[string, string]> = [
  // 0.0.0.0/8 unspecified / this network
  ["0.0.0.0", "unspecified"],
  ["0.1.2.3", "this network"],
  ["0.255.255.255", "this network edge"],
  // 10/8
  ["10.0.0.0", "private"],
  ["10.1.2.3", "private"],
  ["10.255.255.255", "private edge"],
  // 100.64/10 CGNAT
  ["100.64.0.0", "cgnat start"],
  ["100.100.100.100", "cgnat"],
  ["100.127.255.255", "cgnat end"],
  // 127/8 loopback
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback"],
  ["127.1.2.3", "loopback"],
  // 169.254/16 link local + metadata
  ["169.254.0.0", "link-local"],
  ["169.254.169.254", "cloud metadata"],
  ["169.254.255.255", "link-local end"],
  // 172.16/12
  ["172.16.0.0", "private start"],
  ["172.20.5.5", "private"],
  ["172.31.255.255", "private end"],
  // 192.0.0/24, 192.0.2/24
  ["192.0.0.1", "ietf"],
  ["192.0.2.55", "documentation"],
  // 192.88.99/24
  ["192.88.99.1", "6to4 relay"],
  // 192.168/16
  ["192.168.0.0", "private"],
  ["192.168.1.1", "private"],
  ["192.168.255.255", "private end"],
  // 198.18/15 benchmarking
  ["198.18.0.0", "benchmark"],
  ["198.19.255.255", "benchmark end"],
  ["198.51.100.7", "documentation"],
  ["203.0.113.9", "documentation"],
  // multicast and reserved
  ["224.0.0.1", "multicast"],
  ["239.255.255.255", "multicast end"],
  ["240.0.0.1", "reserved"],
  ["255.255.255.255", "broadcast"],
  // IPv6
  ["::", "unspecified"],
  ["::1", "loopback"],
  ["0:0:0:0:0:0:0:1", "loopback long form"],
  ["fc00::1", "ULA"],
  ["fd12:3456:789a::1", "ULA"],
  ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ULA end"],
  ["fe80::1", "link-local"],
  ["febf::1", "link-local end"],
  ["fec0::1", "site-local"],
  ["ff02::1", "multicast"],
  ["ff00::", "multicast"],
  ["2001:db8::1", "documentation"],
  ["2001::1", "teredo"],
  ["2001:1::1", "ietf protocol assignments"],
  ["3fff::1", "documentation"],
  ["100::1", "discard"],
  ["5f00::1", "srv6"],
  ["4000::1", "outside global unicast"],
  ["8000::1", "outside global unicast"],
  ["64:ff9b:1::1", "local-use nat64"],
  // IPv4-mapped IPv6 of every blocked kind
  ["::ffff:127.0.0.1", "mapped loopback"],
  ["::ffff:7f00:1", "mapped loopback hex"],
  ["::ffff:10.0.0.1", "mapped private"],
  ["::ffff:192.168.1.1", "mapped private"],
  ["::ffff:172.16.0.1", "mapped private"],
  ["::ffff:169.254.169.254", "mapped metadata"],
  ["::ffff:a9fe:a9fe", "mapped metadata hex"],
  ["::ffff:100.64.0.1", "mapped cgnat"],
  ["::ffff:0.0.0.0", "mapped unspecified"],
  ["::ffff:224.0.0.1", "mapped multicast"],
  ["0:0:0:0:0:ffff:7f00:1", "mapped long form"],
  ["::ffff:0:127.0.0.1", "ipv4-translated loopback"],
  // IPv4-compatible (deprecated) and embedded forms
  ["::127.0.0.1", "ipv4-compatible loopback"],
  ["::8.8.8.8", "ipv4-compatible is denied outright"],
  ["64:ff9b::7f00:1", "nat64 loopback"],
  ["64:ff9b::a9fe:a9fe", "nat64 metadata"],
  ["64:ff9b::10.0.0.1", "nat64 private"],
  ["2002:7f00:1::1", "6to4 loopback"],
  ["2002:a9fe:a9fe::1", "6to4 metadata"],
  ["2002:c0a8:101::1", "6to4 192.168.1.1"],
];

const ALLOWED: Array<[string, string]> = [
  ["8.8.8.8", "public"],
  ["1.1.1.1", "public"],
  ["93.184.216.34", "public"],
  ["151.101.1.69", "public"],
  ["9.255.255.255", "just below 10/8"],
  ["11.0.0.0", "just above 10/8"],
  ["100.63.255.255", "just below cgnat"],
  ["100.128.0.0", "just above cgnat"],
  ["126.255.255.255", "just below loopback"],
  ["128.0.0.1", "just above loopback"],
  ["169.253.255.255", "just below link-local"],
  ["169.255.0.0", "just above link-local"],
  ["172.15.255.255", "just below 172.16/12"],
  ["172.32.0.0", "just above 172.16/12"],
  ["192.167.255.255", "just below 192.168/16"],
  ["192.169.0.0", "just above 192.168/16"],
  ["198.17.255.255", "just below benchmarking"],
  ["198.20.0.0", "just above benchmarking"],
  ["223.255.255.255", "just below multicast"],
  ["2606:4700:4700::1111", "public v6"],
  ["2a00:1450:4001:81b::200e", "public v6"],
  ["2001:4860:4860::8888", "public v6 (2001:4860)"],
  ["2001:200::1", "public v6 just past 2001::/23"],
  ["2400:cb00::1", "public v6"],
  ["::ffff:8.8.8.8", "mapped PUBLIC address is judged by its embedded IPv4"],
  ["64:ff9b::808:808", "nat64 of a public address"],
  ["2002:808:808::1", "6to4 of a public address"],
];

const MALFORMED = ["", "not-an-ip", "256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "0x7f.0.0.1", "127.1", "2130706433", "::g", ":::1", "1:2:3:4:5:6:7:8:9", "fe80::1%eth0", "[::1]", "1.2.3.4/8", " 8.8.8.8", "8.8.8.8 "];

describe("classifyAddress: refused ranges", () => {
  it.each(BLOCKED)("refuses %s (%s)", (address) => {
    const verdict = classifyAddress(address);
    expect(verdict.allowed, address).toBe(false);
    if (!verdict.allowed) expect(verdict.reason.length).toBeGreaterThan(3);
  });
});

describe("classifyAddress: public addresses and range boundaries are allowed", () => {
  it.each(ALLOWED)("allows %s (%s)", (address) => {
    expect(classifyAddress(address), address).toEqual({ allowed: true });
  });
});

describe("classifyAddress: anything that is not a clean literal is refused (default-deny)", () => {
  it.each(MALFORMED)("refuses %j", (text) => {
    expect(classifyAddress(text).allowed, JSON.stringify(text)).toBe(false);
  });
});

describe("parsers", () => {
  it("parseIPv4 is strict about leading zeros, ranges and shapes", () => {
    expect(parseIPv4("1.2.3.4")).toBe(0x01020304);
    expect(parseIPv4("255.255.255.255")).toBe(0xffffffff);
    for (const bad of ["1.2.3", "1.2.3.4.5", "256.0.0.1", "01.2.3.4", "1.2.3.-4", "a.b.c.d", ""]) expect(parseIPv4(bad), bad).toBeNull();
  });

  it("parseIPv6 expands :: and embedded IPv4, and rejects malformed text", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    for (const bad of ["1::2::3", "12345::", "g::", "1:2:3", "::1.2.3", "fe80::1%1", "1:2:3:4:5:6:7:8:9", "[::1]"]) expect(parseIPv6(bad), bad).toBeNull();
  });

  it("every ULA/link-local boundary is exact (fc00::/7 is fc00-fdff, fe80::/10 is fe80-febf)", () => {
    expect(classifyAddress("fbff::1").allowed).toBe(false); // outside 2000::/3 anyway
    expect(classifyAddress("fe00::1").allowed).toBe(false);
    expect(classifyAddress("fec0::1").allowed).toBe(false);
    expect(classifyAddress("2000::1").allowed).toBe(true);
    expect(classifyAddress("3ffe::1").allowed).toBe(true);
  });
});
