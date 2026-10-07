import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildControllerTools } from "@/domain/ai-controller/controller-tools";
import { buildWriteTools, WRITE_TOOL_PERMISSIONS } from "@/domain/ai-controller/write-tools";
import { AGENT_MODES } from "@/domain/ai-controller/specialist-agents";
import { AUTO_APPROVABLE_ACTION_TYPES, AUTO_APPROVED_ACTION_LABELS } from "@/domain/ai-controller/auto-execution-policy";
import { API_ALLOWED_PERMISSIONS, API_SCOPES, SCOPE_INFO, effectivePermissions, isForbiddenForApi } from "@/domain/api/scopes";
import { PERMISSIONS } from "@/domain/permissions/roles";
import { PERMISSION_AREAS } from "@/domain/permissions/role-info";
import { redactSensitive } from "@/domain/audit/audit-service";
import { allEndpoints } from "@/domain/api/endpoints";

const SRC = path.resolve(__dirname, "../../..");
const WEBHOOKS_DIR = path.join(SRC, "domain/webhooks");
const read = (p: string) => readFileSync(p, "utf8");
const webhookSources = () => readdirSync(WEBHOOKS_DIR).filter((f) => f.endsWith(".ts")).map((f) => ({ name: f, text: read(path.join(WEBHOOKS_DIR, f)) }));

/** Source without comments, so a rule is enforced on code and not on prose that explains it. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("webhook modules: connection discipline (docs/architecture.md section 8 / 11)", () => {
  it("there are webhook modules to check", () => {
    expect(webhookSources().length).toBeGreaterThan(10);
  });

  it("no Promise.all / allSettled / race anywhere: every database and network step is sequential", () => {
    for (const { name, text } of webhookSources()) {
      expect(stripComments(text), name).not.toMatch(/Promise\s*\.\s*(all|allSettled|race|any)\b/);
    }
  });

  it("no module opens its own database connection or pool: all access is through withTenant", () => {
    for (const { name, text } of webhookSources()) {
      const code = stripComments(text);
      expect(code, name).not.toMatch(/from\s+["']pg["']/);
      expect(code, name).not.toMatch(/new\s+(Pool|Client)\b/);
      expect(code, name).not.toMatch(/@\/db\/client/);
      expect(code, name).not.toMatch(/\bdb\s*\.\s*(transaction|execute|select|insert|update|delete)\b/);
    }
  });

  it("no background timers or schedulers are created (retries are on demand)", () => {
    for (const { name, text } of webhookSources()) {
      const code = stripComments(text);
      expect(code, name).not.toMatch(/setInterval\s*\(/);
      expect(code, name).not.toMatch(/node-cron|\bcron\b|bullmq|agenda|pg-boss/i);
    }
    const vercel = JSON.parse(read(path.resolve(SRC, "../vercel.json")));
    expect(vercel.crons).toBeUndefined();
  });

  it("the HTTP client is imported only by the dispatch/outbound layer and never inside a withTenant callback in the dispatcher's send path", () => {
    const dispatch = stripComments(read(path.join(WEBHOOKS_DIR, "dispatch-service.ts")));
    // sendWebhook is called from attemptAndRecord, which is itself never called inside a withTenant callback.
    const sendCalls = [...dispatch.matchAll(/sendWebhook\s*\(/g)];
    expect(sendCalls).toHaveLength(1);
    const attemptIdx = dispatch.indexOf("async function attemptAndRecord");
    const recordIdx = dispatch.indexOf("async function recordOutcome");
    expect(sendCalls[0]!.index!).toBeGreaterThan(attemptIdx);
    expect(sendCalls[0]!.index!).toBeLessThan(recordIdx);
    // The runtime proof (no scoped transaction open at the instant the client runs) is in the dispatch integration test.
  });

  it("TLS verification is never disabled anywhere in the webhook code", () => {
    for (const { name, text } of webhookSources()) {
      const code = stripComments(text);
      expect(code, name).not.toMatch(/rejectUnauthorized\s*:\s*false/);
      expect(code, name).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
      expect(code, name).not.toMatch(/checkServerIdentity/);
      expect(code, name).not.toMatch(/followRedirects|maxRedirects|redirect\s*:\s*["']follow["']/);
    }
  });

  it("the secret is never logged: no console call in the webhook modules", () => {
    for (const { name, text } of webhookSources()) expect(stripComments(text), name).not.toMatch(/console\s*\.\s*(log|info|warn|error|debug)/);
  });
});

describe("webhook management is human-only and unreachable from the API and the AI", () => {
  it("webhook:manage is a real permission with a plain-language area, and every API scope table excludes it", () => {
    expect(PERMISSIONS).toContain("webhook:manage");
    expect(PERMISSION_AREAS.webhook).toBe("Webhooks");
    expect(isForbiddenForApi("webhook:manage")).toBe(true);
    expect(API_ALLOWED_PERMISSIONS.has("webhook:manage")).toBe(false);
    for (const scope of API_SCOPES) expect(JSON.stringify(SCOPE_INFO[scope])).not.toMatch(/webhook/i);
    expect(effectivePermissions([...API_SCOPES], "OWNER").has("webhook:manage")).toBe(false);
  });

  it("no public API endpoint manages, lists or even mentions webhooks", () => {
    for (const e of allEndpoints()) {
      expect(e.path, e.path).not.toMatch(/webhook/i);
      expect(e.permissions, e.path).not.toContain("webhook:manage");
    }
  });

  it("no AI read/write tool, specialist mode or auto-execution entry concerns webhooks", () => {
    const hook = /web[\s_.-]?hook|domain[\s_-]?event|outbox|webhook:manage/i;
    for (const t of buildControllerTools([])) {
      expect(t.name, t.name).not.toMatch(hook);
      expect(t.description, t.name).not.toMatch(hook);
      expect(t.permission, t.name).not.toBe("webhook:manage");
    }
    for (const t of buildWriteTools("q", "m")) {
      expect(t.name, t.name).not.toMatch(hook);
      expect(t.description, t.name).not.toMatch(hook);
      expect(t.permission, t.name).not.toBe("webhook:manage");
    }
    for (const [name, permission] of Object.entries(WRITE_TOOL_PERMISSIONS)) {
      expect(name).not.toMatch(hook);
      expect(permission).not.toBe("webhook:manage");
    }
    for (const mode of Object.values(AGENT_MODES)) for (const n of [...(mode.readToolNames ?? []), ...mode.writeToolNames]) expect(n).not.toMatch(hook);
    for (const type of AUTO_APPROVABLE_ACTION_TYPES) {
      expect(type).not.toMatch(hook);
      expect(AUTO_APPROVED_ACTION_LABELS[type]).not.toMatch(hook);
    }
  });

  it("the AI source tree never imports the webhook modules, and only the settings/dispatch layers import the management services", () => {
    const aiDir = path.join(SRC, "domain/ai-controller");
    for (const f of readdirSync(aiDir).filter((x) => x.endsWith(".ts"))) {
      expect(read(path.join(aiDir, f)), f).not.toMatch(/domain\/webhooks|WebhookSubscriptionService|WebhookDispatchService|webhook:manage/);
    }
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && /webhooks\/(subscription-service|dispatch-service|delivery-queries)/.test(read(full))) importers.push(path.relative(SRC, full));
      }
    };
    walk(path.join(SRC, "domain"));
    walk(path.join(SRC, "app"));
    walk(path.join(SRC, "components"));
    for (const file of importers) {
      expect(file.startsWith("domain/webhooks/") || file.startsWith("app/[orgSlug]/settings/webhooks/") || file === "app/[orgSlug]/settings/page.tsx" || file.startsWith("components/shell/"), file).toBe(true);
    }
  });
});

describe("secrets never reach the audit log", () => {
  it("redaction masks every webhook secret field name, at any depth", () => {
    const redacted = JSON.stringify(redactSensitive({ a: { secretCiphertext: "c", previousSecretCiphertext: "p", secret_ciphertext: "c2", signingSecret: "s", nested: [{ signing_secret: "s2" }] }, url: "https://x.example.com" }));
    expect(redacted).not.toMatch(/"c"|"p"|"c2"|"s"|"s2"/);
    expect(redacted).toContain("https://x.example.com");
  });
});
