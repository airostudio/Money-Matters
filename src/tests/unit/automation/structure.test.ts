import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Structural guarantees for the Phase 10 Slice 3 modules, read from the source (the same technique as the archived-company
 * and webhook structure tests): no parallel database fan-out, no private connection, no timers or schedulers, no code
 * evaluation, no raw network access, no stray logging of secrets, and nothing on the shared-layout hot path.
 */
const SRC = path.resolve(__dirname, "../../..");
const ROOT = path.resolve(SRC, "..");

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return filesIn(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
/** Source with comments removed, so prose describing a call is not mistaken for making it. */
const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const NEW_FILES = [
  ...filesIn(path.join(SRC, "domain/automation")),
  ...filesIn(path.join(SRC, "domain/integrations")),
  ...filesIn(path.join(SRC, "domain/notifications")),
  path.join(SRC, "domain/security/secret-encryption.ts"),
  ...filesIn(path.join(SRC, "app/[orgSlug]/settings/automation")),
  ...filesIn(path.join(SRC, "app/[orgSlug]/settings/integrations")),
  ...filesIn(path.join(SRC, "app/[orgSlug]/notifications")),
  path.join(SRC, "components/shell/automation-rule-form.tsx"),
  path.join(SRC, "components/shell/connect-slack-form.tsx"),
];
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

describe("new modules: connection discipline and no scheduler", () => {
  it("there are modules to check", () => {
    expect(NEW_FILES.length).toBeGreaterThan(25);
  });

  it("no Promise.all / allSettled / race / any: all database work is sequential", () => {
    for (const f of NEW_FILES) expect(code(f), rel(f)).not.toMatch(/Promise\.(all|allSettled|race|any)\b/);
  });

  it("no private database connection or pool", () => {
    for (const f of NEW_FILES) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/from ["']pg["']/);
      expect(c, rel(f)).not.toMatch(/new (Pool|Client)\(/);
      expect(c, rel(f)).not.toMatch(/DIRECT_DATABASE_URL|connectionString/);
    }
  });

  it("no timers, schedulers, cron or queues (owner decision: automations run on demand)", () => {
    for (const f of NEW_FILES) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/\b(setInterval|setTimeout|setImmediate)\s*\(/);
      expect(c, rel(f)).not.toMatch(/node-cron|cron-parser|bullmq|agenda|bee-queue|pg-boss|\bcrontab\b/i);
    }
    const vercel = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8")) as Record<string, unknown>;
    expect(vercel).not.toHaveProperty("crons");
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) expect(name, name).not.toMatch(/cron|bull|agenda|queue|schedul|inngest|trigger\.dev/i);
  });

  it("no code evaluation anywhere in the vocabulary, engine or form handling", () => {
    for (const f of NEW_FILES) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/\beval\s*\(/);
      expect(c, rel(f)).not.toMatch(/new\s+Function\s*\(/);
      expect(c, rel(f)).not.toMatch(/\bvm\.|from ["']node:vm["']|from ["']vm["']/);
      expect(c, rel(f)).not.toMatch(/child_process/);
      expect(c, rel(f)).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });

  it("raw SQL in the engine is confined to fixed statements with bound parameters (no string-built SQL from rule data)", () => {
    for (const f of NEW_FILES.filter((x) => rel(x).startsWith("domain/automation/"))) {
      const c = code(f);
      // sql.raw may only ever receive a constant: a plain string literal (no interpolation) or the operator looked up from the fixed table.
      let from = 0;
      for (;;) {
        const at = c.indexOf("sql.raw(", from);
        if (at < 0) break;
        const rest = c.slice(at);
        const constant = /^sql\.raw\((?:"[^"$]*"|'[^'$]*'|`[^`$]*`|op)\)/.test(rest);
        expect(constant, `${rel(f)}: ${rest.slice(0, 80)}`).toBe(true);
        from = at + 8;
      }
    }
  });

  it("outbound network access in the new modules goes ONLY through the SSRF-guarded client (no fetch, https, http, net, axios)", () => {
    for (const f of NEW_FILES) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/\bfetch\s*\(/);
      expect(c, rel(f)).not.toMatch(/from ["']node:(https?|net|tls|dns)["']|from ["'](https?|net|tls|dns|axios|got|node-fetch|undici)["']/);
      expect(c, rel(f)).not.toMatch(/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/);
    }
    // ...and the one place that sends reuses the webhook slice's client.
    expect(code(path.join(SRC, "domain/integrations/providers/slack-incoming-webhook.ts"))).toMatch(/sendWebhook\(/);
  });

  it("no logging that could carry a secret from the credential-handling modules", () => {
    for (const f of [
      "domain/integrations/connection-service.ts",
      "domain/integrations/providers/slack-incoming-webhook.ts",
      "domain/security/secret-encryption.ts",
      "domain/automation/executors.ts",
      "domain/automation/engine.ts",
      "app/[orgSlug]/settings/integrations/actions.ts",
    ]) {
      expect(code(path.join(SRC, f)), f).not.toMatch(/console\./);
    }
  });

  it("the secret-bearing form fields are never rendered back (no defaultValue / value on the webhook URL input)", () => {
    const form = code(path.join(SRC, "components/shell/connect-slack-form.tsx"));
    const urlInput = form.match(/<Input[^>]*name="webhookUrl"[^>]*\/>/)?.[0] ?? "";
    expect(urlInput).toContain('type="password"');
    expect(urlInput).not.toMatch(/defaultValue|value=/);
  });
});

describe("the shared layout and shell stay free of the new features (hot path)", () => {
  const HOT = [
    "app/[orgSlug]/layout.tsx",
    "components/shell/dashboard-shell.tsx",
    "components/shell/sidebar.tsx",
    "components/shell/topbar.tsx",
    "components/shell/mobile-nav.tsx",
    "components/shell/nav-links.tsx",
    "components/shell/nav-config.ts",
    "db/tenant.ts",
  ];
  it("no notification, automation or integration query or import in the layout, the shell or withTenant", () => {
    for (const f of HOT) {
      const c = code(path.join(SRC, f));
      expect(c, f).not.toMatch(/NotificationService|notification-service|automation|integration|schema["']\s*;?[\s\S]{0,40}notifications/i);
      expect(c, f).not.toMatch(/unreadCount|from\(notifications\)/);
    }
  });
  it("the nav item has no live badge", () => {
    const nav = code(path.join(SRC, "components/shell/nav-config.ts"));
    expect(nav).toMatch(/label: "Notifications", href: "\/notifications"/);
    expect(nav).not.toMatch(/\bbadge\b|unread|\bcount\b/i);
  });
  it("only the notifications page and the home page read the unread count", () => {
    const users = filesIn(SRC)
      .filter((f) => !f.includes(`${path.sep}tests${path.sep}`) && /unreadCount\(/.test(code(f)))
      .map(rel)
      .sort();
    expect(users).toEqual(["app/[orgSlug]/notifications/page.tsx", "app/[orgSlug]/page.tsx", "domain/notifications/notification-service.ts"]);
  });
});

describe("exclusions: nothing automation- or integration-related is reachable from the AI controller, the public API or auto-execution", () => {
  const importsOf = (dir: string) => filesIn(path.join(SRC, dir));
  it("no AI controller module imports the automation, integration or notification services", () => {
    for (const f of importsOf("domain/ai-controller")) expect(code(f), rel(f)).not.toMatch(/domain\/automation|domain\/integrations|domain\/notifications|connection-service|rule-service|secret-encryption/);
  });
  it("no public API module or route imports them either", () => {
    for (const f of [...importsOf("domain/api"), ...importsOf("app/api")]) expect(code(f), rel(f)).not.toMatch(/domain\/automation|domain\/integrations|domain\/notifications|connection-service|rule-service/);
  });
  it("the automation engine imports no human-only management service (periods, payments, payroll, journals, membership, API keys, webhooks subscriptions, AI autonomy)", () => {
    const FORBIDDEN = /(close\/period|period-lock-service|period-close-service|payroll\/|payment-service|payment-run-service|bank-service|journal|posting-service|ledger-service|organization-service|lifecycle-service|invite-service|api-key-service|subscription-service|ai-controller|autonomy|supplier-payment|bill-service|invoice-service)/;
    for (const f of filesIn(path.join(SRC, "domain/automation"))) {
      for (const match of code(f).matchAll(/from ["']@\/domain\/([^"']+)["']/g)) {
        expect(match[1], `${rel(f)} imports ${match[1]}`).not.toMatch(FORBIDDEN);
      }
    }
  });
});
