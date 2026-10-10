import { FAKE_SLACK_URL } from "../../helpers/slack";
import { describe, expect, it } from "vitest";
import { SLACK_ALLOWED_HOSTS, SLACK_PROVIDER_ID, SLACK_TEST_MESSAGE, buildSlackPayload, checkSlackUrl, escapeSlack, maskSlackUrl, sendSlackMessage, slackIncomingWebhookProvider } from "@/domain/integrations/providers/slack-incoming-webhook";
import { COMING_SOON_PROVIDERS } from "@/domain/integrations/catalog";
import { getProvider, hasCapability, isComingSoon, listCatalog } from "@/domain/integrations/registry";
import { INTEGRATION_CATEGORIES, type ChannelMessage } from "@/domain/integrations/provider";
import { describeSubject, appBaseUrl } from "@/domain/automation/messages";
import type { JobContext } from "@/domain/automation/context";
import { contextFromEvent } from "@/domain/automation/context";
import { groupKeyOf, safeInAppLink } from "@/domain/notifications/notification-service";
import { fakeResolver, fakeTransport } from "../../helpers/webhooks";

const GOOD = FAKE_SLACK_URL;

describe("Slack incoming-webhook destination: host allowlist AND the SSRF guard", () => {
  it("accepts exactly the documented shape on the allowlisted host", () => {
    expect([...SLACK_ALLOWED_HOSTS]).toEqual(["hooks.slack.com"]);
    expect(checkSlackUrl(GOOD).ok).toBe(true);
    expect(checkSlackUrl(`  ${GOOD}  `).ok).toBe(true); // surrounding whitespace from a paste
    expect(checkSlackUrl("https://HOOKS.SLACK.COM/services/T1/B1/xyz").ok).toBe(true); // host names are case-insensitive
    expect(checkSlackUrl("https://hooks.slack.com:443/services/T1/B1/xyz").ok).toBe(true); // the default port, spelled out
    expect(checkSlackUrl("https://hooks.slack.com./services/T1/B1/xyz").ok).toBe(true); // a rooted DNS name is the same host
  });

  it.each([
    ["a lookalike with the allowed host as a prefix", "https://hooks.slack.com.evil.com/services/T1/B1/xyz"],
    ["a lookalike with the allowed host as a suffix", "https://evilhooks.slack.com/services/T1/B1/xyz"],
    ["a different subdomain of slack.com", "https://api.slack.com/services/T1/B1/xyz"],
    ["the bare domain", "https://slack.com/services/T1/B1/xyz"],
    ["a subdomain trick with a dash", "https://hooks-slack.com/services/T1/B1/xyz"],
    ["a different TLD", "https://hooks.slack.co/services/T1/B1/xyz"],
    ["userinfo naming the allowed host before an evil one", "https://hooks.slack.com@evil.com/services/T1/B1/xyz"],
    ["userinfo naming an evil host before the allowed one", "https://evil.com@hooks.slack.com/services/T1/B1/xyz"],
    ["userinfo with a password", "https://user:pass@hooks.slack.com/services/T1/B1/xyz"],
    ["a non-standard port", "https://hooks.slack.com:8443/services/T1/B1/xyz"],
    ["port 80", "https://hooks.slack.com:80/services/T1/B1/xyz"],
    ["plain http", "http://hooks.slack.com/services/T1/B1/xyz"],
    ["no scheme", "hooks.slack.com/services/T1/B1/xyz"],
    ["a loopback IP literal", "https://127.0.0.1/services/T1/B1/xyz"],
    ["a private IP literal", "https://10.0.0.5/services/T1/B1/xyz"],
    ["the cloud metadata address", "https://169.254.169.254/services/T1/B1/xyz"],
    ["an IPv6 loopback literal", "https://[::1]/services/T1/B1/xyz"],
    ["a decimal-encoded IP", "https://2130706433/services/T1/B1/xyz"],
    ["a hex-encoded IP", "https://0x7f000001/services/T1/B1/xyz"],
    ["localhost", "https://localhost/services/T1/B1/xyz"],
    ["an internal name", "https://hooks.slack.internal/services/T1/B1/xyz"],
    ["an unrelated public host", "https://hooks.example.com/services/T1/B1/xyz"],
    ["a backslash host trick", "https://evil.com\\@hooks.slack.com/services/T1/B1/xyz"],
    ["a fragment", `${GOOD}#frag`],
    ["a query string", `${GOOD}?x=1`],
    ["the wrong path", "https://hooks.slack.com/other/T1/B1/xyz"],
    ["a path that is too short", "https://hooks.slack.com/services/T1/B1"],
    ["a path with extra segments", "https://hooks.slack.com/services/T1/B1/xyz/extra"],
    ["path traversal", "https://hooks.slack.com/services/../../etc/passwd"],
    ["encoded slashes", "https://hooks.slack.com/services%2FT1%2FB1%2Fxyz"],
    ["control characters", "https://hooks.slack.com/services/T1/B1/xy\u0000z"],
    ["an embedded space", "https://hooks.slack.com/services/T1/B1/x yz"],
    ["empty", ""],
    ["whitespace", "   "],
    ["javascript:", "javascript:alert(1)"],
  ])("refuses %s", (_label, url) => {
    expect(checkSlackUrl(url).ok).toBe(false);
  });

  it("an over-long URL is refused", () => {
    expect(checkSlackUrl(`https://hooks.slack.com/services/T1/B1/${"a".repeat(3000)}`).ok).toBe(false);
  });

  it("validateConfig splits the secret from the public settings and masks the URL", () => {
    const result = slackIncomingWebhookProvider.validateConfig({ webhookUrl: GOOD, includeAmounts: true, channelLabel: "#finance" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secretConfig).toEqual({ webhookUrl: GOOD });
    expect(JSON.stringify(result.publicConfig)).not.toContain(GOOD);
    expect(JSON.stringify(result.publicConfig)).not.toContain("T0123ABCD");
    expect(result.publicConfig).toEqual({ includeAmounts: true, channelLabel: "#finance", maskedUrl: "hooks.slack.com/services/…UVWX" });
    // amounts are off unless asked for
    const defaults = slackIncomingWebhookProvider.validateConfig({ webhookUrl: GOOD });
    expect(defaults.ok && defaults.publicConfig.includeAmounts).toBe(false);
  });

  it("validateConfig refuses unknown keys and bad URLs without echoing them", () => {
    expect(slackIncomingWebhookProvider.validateConfig({ webhookUrl: GOOD, extra: 1 }).ok).toBe(false);
    const bad = slackIncomingWebhookProvider.validateConfig({ webhookUrl: "https://evil.example.com/services/T1/B1/secretsecret" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).not.toContain("secretsecret");
  });

  it("maskSlackUrl never reveals more than the host and the last four characters", () => {
    expect(maskSlackUrl(GOOD)).toBe("hooks.slack.com/services/…UVWX");
    expect(maskSlackUrl("garbage-token-1234")).toBe("…1234");
  });
});

describe("sending: the allowlist is re-applied before the SSRF-guarded client is ever called", () => {
  const message: ChannelMessage = { title: "T", body: "B", linkUrl: null, severity: "INFO", amountLine: null };

  it("an allowed host reaches the (fake) client with the Slack payload and no redirects followed", async () => {
    const transport = fakeTransport();
    const result = await sendSlackMessage(GOOD, message, { includeAmounts: false }, { resolver: fakeResolver(), transport });
    expect(result.ok).toBe(true);
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    expect(call.url.hostname).toBe("hooks.slack.com");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call.body)).toEqual({ text: "*T*\nB" });
  });

  it("non-allowlisted, lookalike, private and localhost URLs NEVER invoke the client or even the resolver", async () => {
    for (const url of ["https://hooks.slack.com.evil.com/services/T1/B1/xyz", "https://evilhooks.slack.com/services/T1/B1/xyz", "https://localhost/services/T1/B1/xyz", "https://127.0.0.1/services/T1/B1/xyz", "http://hooks.slack.com/services/T1/B1/xyz", "https://10.1.2.3/services/T1/B1/xyz"]) {
      const transport = fakeTransport();
      const resolver = fakeResolver();
      const result = await sendSlackMessage(url, message, { includeAmounts: false }, { resolver, transport });
      expect(result.ok, url).toBe(false);
      expect(result.errorClass, url).toBe("ssrf_blocked");
      expect(transport.calls, url).toHaveLength(0);
      expect(resolver.calls, url).toHaveLength(0);
    }
  });

  it("an allowlisted name that RESOLVES to a private address is refused by the SSRF guard (DNS rebinding / poisoning)", async () => {
    const transport = fakeTransport();
    const result = await sendSlackMessage(GOOD, message, { includeAmounts: false }, { resolver: fakeResolver({ "hooks.slack.com": ["10.0.0.7"] }), transport });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("ssrf_blocked");
    expect(transport.calls).toHaveLength(0);
    const mixed = await sendSlackMessage(GOOD, message, { includeAmounts: false }, { resolver: fakeResolver({ "hooks.slack.com": ["93.184.216.34", "169.254.169.254"] }), transport });
    expect(mixed.ok).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });

  it("a redirect from Slack is a failure, never followed", async () => {
    const transport = fakeTransport(() => ({ status: 302, bodyExcerpt: Buffer.from("moved") }));
    const result = await sendSlackMessage(GOOD, message, { includeAmounts: false }, { resolver: fakeResolver(), transport });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("redirect");
    expect(transport.calls).toHaveLength(1);
  });

  it("an HTTP error reports the status without leaking the URL or the response body", async () => {
    const transport = fakeTransport(() => ({ status: 404, bodyExcerpt: Buffer.from("no_service") }));
    const result = await sendSlackMessage(GOOD, message, { includeAmounts: false }, { resolver: fakeResolver(), transport });
    expect(result).toMatchObject({ ok: false, statusCode: 404, errorClass: "http_error", message: "Slack answered HTTP 404." });
    expect(JSON.stringify(result)).not.toContain("T0123ABCD");
  });

  it("connect() vets DNS without sending anything; testConnection sends the labelled test message", async () => {
    const transport = fakeTransport();
    const ctx = { organizationId: "o", connectionId: "c", config: { webhookUrl: GOOD, includeAmounts: true } };
    const ok = await slackIncomingWebhookProvider.connect(ctx, { resolver: fakeResolver(), transport });
    expect(ok.ok).toBe(true);
    expect(transport.calls).toHaveLength(0);
    const rejected = await slackIncomingWebhookProvider.connect(ctx, { resolver: fakeResolver({ "hooks.slack.com": ["127.0.0.1"] }), transport });
    expect(rejected.ok).toBe(false);
    const tested = await slackIncomingWebhookProvider.testConnection(ctx, { resolver: fakeResolver(), transport });
    expect(tested.ok).toBe(true);
    const text = JSON.parse(transport.calls[0]!.body).text as string;
    expect(text).toContain("Money Matters test message");
    expect(SLACK_TEST_MESSAGE.amountLine).toBeNull();
  });
});

describe("Slack payload: minimal by default, escaped, amounts only on request", () => {
  const message: ChannelMessage = { title: "Big invoice", body: "Invoice INV-1 for Acme was created.", linkUrl: "https://app.example.test/acme/sales/invoices/1", severity: "WARNING", amountLine: "Total 1100.00 AUD" };

  it("has no amount unless the connection opted in, and is exactly {text}", () => {
    const off = buildSlackPayload(message, { includeAmounts: false });
    expect(Object.keys(off)).toEqual(["text"]);
    expect(off.text).not.toMatch(/1100|Total/);
    expect(off.text).toContain("Invoice INV-1 for Acme was created.");
    expect(off.text).toContain("<https://app.example.test/acme/sales/invoices/1|Open in Money Matters>");
    expect(off.text.startsWith("*[Warning] Big invoice*")).toBe(true);
    const on = buildSlackPayload(message, { includeAmounts: true });
    expect(on.text).toContain("Total 1100.00 AUD");
  });

  it("escapes Slack control characters so text can never become a mention, a channel ping or a link", () => {
    expect(escapeSlack("<!channel> & <!here> <@U123> <http://evil|click>")).toBe("&lt;!channel&gt; &amp; &lt;!here&gt; &lt;@U123&gt; &lt;http://evil|click&gt;");
    const payload = buildSlackPayload({ ...message, title: "<!channel> pwn", body: "<@U123|admin> see <https://evil.example|here>" }, { includeAmounts: false });
    expect(payload.text).not.toMatch(/<!channel>|<@U123|<https:\/\/evil/);
    expect(payload.text).toContain("&lt;!channel&gt; pwn");
  });

  it("only attaches our own https link, and never one carrying markup characters", () => {
    for (const linkUrl of ["http://app.example.test/x", "javascript:alert(1)", "https://app.example.test/x|evil>", "https://app.example.test/<x>", "https://app.example.test/a b"]) {
      expect(buildSlackPayload({ ...message, linkUrl }, { includeAmounts: false }).text, linkUrl).not.toContain("Open in Money Matters");
    }
  });

  it("is length-capped and single-line in the title", () => {
    const payload = buildSlackPayload({ ...message, title: "line1\nline2", body: "x".repeat(10_000) }, { includeAmounts: false });
    expect(payload.text.length).toBeLessThanOrEqual(3000);
    expect(payload.text.split("\n")[0]).toBe("*[Warning] line1 line2*");
  });
});

describe("the provider registry and catalogue", () => {
  it("lists every spec'd provider, the one real provider first, the rest clearly labelled unavailable", () => {
    const catalog = listCatalog();
    expect(catalog[0]).toMatchObject({ id: SLACK_PROVIDER_ID, availability: "AVAILABLE", category: "MESSAGING", capabilities: ["send"], needs: null });
    const ids = catalog.map((c) => c.id);
    for (const required of ["basiq", "plaid", "yodlee", "stripe", "paypal", "square", "shopify", "woocommerce", "amazon", "ebay", "hubspot", "salesforce", "gmail", "outlook", "google_drive", "onedrive", "microsoft_teams"]) expect(ids, required).toContain(required);
    expect(catalog.filter((c) => c.availability === "AVAILABLE")).toHaveLength(1);
    for (const entry of catalog.slice(1)) {
      expect(entry.availability).toBe("COMING_SOON");
      expect(entry.capabilities).toEqual([]);
      expect(entry.needs?.length ?? 0).toBeGreaterThan(20);
      expect(INTEGRATION_CATEGORIES as readonly string[]).toContain(entry.category);
    }
  });

  it("covers every category in the spec (banking, payments, e-commerce, CRM, payroll/HR, productivity, messaging, storage)", () => {
    const categories = new Set(listCatalog().map((c) => c.category));
    for (const category of INTEGRATION_CATEGORIES) expect(categories.has(category), category).toBe(true);
  });

  it("a coming-soon entry NEVER resolves to a working provider (no stub connectors that pretend to work)", () => {
    for (const entry of COMING_SOON_PROVIDERS) {
      expect(getProvider(entry.id), entry.id).toBeUndefined();
      expect(hasCapability(entry.id, "send"), entry.id).toBe(false);
      expect(isComingSoon(entry.id)).toBe(true);
      expect(Object.keys(entry).sort()).toEqual(["availability", "category", "description", "id", "name", "needs"]); // data only: no functions
      for (const value of Object.values(entry)) expect(typeof value).toBe("string");
    }
    expect(getProvider("slack_incoming_webhook")).toBe(slackIncomingWebhookProvider);
    expect(getProvider("nonexistent")).toBeUndefined();
  });

  it("Teams is deferred with the reason stated, not implemented", () => {
    const teams = listCatalog().find((c) => c.id === "microsoft_teams")!;
    expect(teams.availability).toBe("COMING_SOON");
    expect(teams.needs).toMatch(/could not be verified/);
  });

  it("the Slack provider declares what the framework needs: schema, secret fields, capabilities, and send iff capable", () => {
    const p = slackIncomingWebhookProvider;
    expect(p.secretFields).toEqual(["webhookUrl"]);
    expect(p.capabilities).toEqual(["send"]);
    expect(typeof p.send).toBe("function");
    expect(typeof p.connect).toBe("function");
    expect(typeof p.testConnection).toBe("function");
    expect(typeof p.disconnect).toBe("function");
    expect(p.configSchema.safeParse({ webhookUrl: GOOD }).success).toBe(true);
  });
});

describe("message content: minimal, with no template language", () => {
  const ctx = contextFromEvent("invoice.created", "e1", {
    data: { object: { id: "11111111-1111-4111-8111-111111111111", number: "INV-0007", currency: "AUD", total: { amount: "1100.00", currency: "AUD" }, amount_due: { amount: "1100.00", currency: "AUD" }, due_date: "2026-01-31", customer: { id: "22222222-2222-4222-8222-222222222222", display_name: "Acme Pty Ltd" } } },
  });

  it("extracts only public data from an event payload, with decimal strings", () => {
    expect(ctx).toMatchObject({ objectType: "Invoice", number: "INV-0007", name: "Acme Pty Ltd", total: "1100.00", amountDue: "1100.00", currency: "AUD", dueDate: "2026-01-31" });
    expect(ctx.facts).toMatchObject({ total: "1100.00", amount_due: "1100.00", customer_id: "22222222-2222-4222-8222-222222222222", currency: "AUD" });
  });

  it("the default body names what happened and links; the amount is a separate line the destination must opt into", () => {
    const d = describeSubject(ctx, "acme", "Big invoice");
    expect(d.body).toBe("Invoice INV-0007 for Acme Pty Ltd was created.");
    expect(d.path).toBe("/acme/sales/invoices/11111111-1111-4111-8111-111111111111");
    expect(d.body).not.toMatch(/1100/);
    expect(d.amountLine).toBe("Total 1100.00 AUD");
  });

  it("placeholders in a custom message are inert text, not substituted", () => {
    const d = describeSubject(ctx, "acme", "Rule", "{{invoice.total}} ${total} %s");
    expect(d.body.startsWith("{{invoice.total}} ${total} %s Invoice")).toBe(true);
    expect(d.body).not.toMatch(/1100/);
  });

  it("garbage payloads degrade to nulls and never throw", () => {
    for (const payload of [null, undefined, "x", 3, [], {}, { data: null }, { data: { object: "str" } }, { data: { object: { total: 5, customer: 7 } } }]) {
      expect(() => contextFromEvent("invoice.created", "e", payload)).not.toThrow();
    }
    const c = contextFromEvent("invoice.created", "e", { data: { object: { total: { amount: "NaN" } } } });
    expect(c.facts.total).toBeNull();
  });

  it("links are only ever in-app paths; a link base is only an https origin or local http", () => {
    expect(safeInAppLink("/acme/sales/invoices/1")).toBe("/acme/sales/invoices/1");
    for (const bad of ["https://evil.com", "//evil.com/x", "/../x", "javascript:alert(1)", "/a/../b", "", null]) expect(safeInAppLink(bad as string | null), String(bad)).toBeNull();
    expect(appBaseUrl({ NEXTAUTH_URL: "https://app.example.com/some/path" })).toBe("https://app.example.com");
    expect(appBaseUrl({ NEXTAUTH_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
    expect(appBaseUrl({ NEXTAUTH_URL: "http://evil.example.com" })).toBeNull();
    expect(appBaseUrl({})).toBeNull();
  });

  it("identical items share a group key; different rules or text do not", () => {
    const a = { source: "automation" as const, sourceRefId: "r1", severity: "INFO" as const, title: "T", body: "B" };
    expect(groupKeyOf(a)).toBe(groupKeyOf({ ...a }));
    expect(groupKeyOf(a)).not.toBe(groupKeyOf({ ...a, sourceRefId: "r2" }));
    expect(groupKeyOf(a)).not.toBe(groupKeyOf({ ...a, body: "B2" }));
    expect(groupKeyOf(a)).not.toBe(groupKeyOf({ ...a, severity: "ACTION" }));
  });
});
