import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildControllerTools } from "@/domain/ai-controller/controller-tools";
import { buildWriteTools, WRITE_TOOL_PERMISSIONS } from "@/domain/ai-controller/write-tools";
import { AGENT_MODES } from "@/domain/ai-controller/specialist-agents";
import { AUTO_APPROVABLE_ACTION_TYPES, AUTO_APPROVED_ACTION_LABELS, EXCLUDED_ACTION_TYPE_EXAMPLES } from "@/domain/ai-controller/auto-execution-policy";

/**
 * AI boundary (docs/ai-agents.md): the AI Financial Controller has NO tool that touches API keys, and nothing about
 * keys can be auto-executed. Mirrors the admin and close slices' registry-exclusion tests.
 */
const API_KEYISH = /api[\s_.-]?key|api_key|apikey|api[\s_.-]?access|bearer|mm_live|\bscopes?\b|developer[\s_-]?api/i;

describe("the AI controller cannot reach API keys", () => {
  const readTools = buildControllerTools([]);
  const writeTools = buildWriteTools("test question", "test-model");

  it("no READ tool (name, description or required permission) concerns API keys", () => {
    expect(readTools.length).toBeGreaterThan(5);
    for (const t of readTools) {
      expect(t.name, t.name).not.toMatch(API_KEYISH);
      expect(t.description, t.name).not.toMatch(API_KEYISH);
      expect(t.permission, t.name).not.toBe("api_key:manage");
      expect(t.permission, t.name).not.toMatch(/^api_key/);
    }
  });

  it("no WRITE tool (name, description or required permission) concerns API keys", () => {
    expect(writeTools.length).toBeGreaterThan(2);
    for (const t of writeTools) {
      expect(t.name, t.name).not.toMatch(API_KEYISH);
      expect(t.description, t.name).not.toMatch(API_KEYISH);
      expect(t.permission, t.name).not.toMatch(/^api_key/);
    }
    for (const [name, permission] of Object.entries(WRITE_TOOL_PERMISSIONS)) {
      expect(name).not.toMatch(API_KEYISH);
      expect(permission).not.toMatch(/^api_key/);
    }
  });

  it("no specialist agent mode lists such a tool", () => {
    const registered = new Set([...readTools, ...writeTools].map((t) => t.name));
    for (const mode of Object.values(AGENT_MODES)) {
      for (const name of [...(mode.readToolNames ?? []), ...mode.writeToolNames]) {
        expect(name).not.toMatch(API_KEYISH);
        expect(registered.has(name), `${mode.id}: ${name} is a registered tool`).toBe(true);
      }
    }
  });

  it("the auto-execution allowlist contains nothing about API keys, and the permanent exclusions are unchanged", () => {
    for (const type of AUTO_APPROVABLE_ACTION_TYPES) {
      expect(type).not.toMatch(API_KEYISH);
      expect(AUTO_APPROVED_ACTION_LABELS[type]).not.toMatch(API_KEYISH);
    }
    expect([...AUTO_APPROVABLE_ACTION_TYPES]).toEqual(["RECURRING_INVOICE_AUTO_GENERATE", "RECURRING_BILL_AUTO_GENERATE", "BANK_RECONCILIATION_AUTO_MATCH"]);
    expect(EXCLUDED_ACTION_TYPE_EXAMPLES.length).toBeGreaterThan(5);
  });

  it("the AI source tree never imports the API module or the key service", () => {
    const dir = path.resolve(__dirname, "../../../domain/ai-controller");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(path.join(dir, f), "utf8"));
    expect(sources.length).toBeGreaterThan(5);
    for (const s of sources) {
      expect(s).not.toMatch(/@\/domain\/api\//);
      expect(s).not.toMatch(/ApiKeyService|api_key:manage|api-key-service/);
    }
    // And nothing outside the API/permissions/audit/settings layers imports the key service: it is a human-only surface.
    const root = path.resolve(__dirname, "../../..");
    const importers: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const full = path.join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && /api-key-service/.test(readFileSync(full, "utf8"))) importers.push(path.relative(root, full));
      }
    };
    walk(path.join(root, "domain"));
    walk(path.join(root, "app"));
    expect(importers.sort()).toEqual(["app/[orgSlug]/settings/api/actions.ts", "app/[orgSlug]/settings/api/page.tsx"]);
  });
});
