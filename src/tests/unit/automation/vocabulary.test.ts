import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  ACTION_TYPES,
  EVENT_TRIGGERS,
  MAX_CONDITIONS,
  OPERATORS,
  SCAN_TRIGGERS,
  TRIGGERS,
  TRIGGER_FIELDS,
  daysOverdue,
  daysUntilDue,
  dueSoonJobKey,
  eventJobKey,
  evaluateCondition,
  evaluateConditions,
  overdueJobKey,
  reorderJobKey,
  retryDelayMs,
  validateCondition,
  validateRuleSpec,
  MAX_SEND_ATTEMPTS,
  MAX_ORG_RUNS_PER_PASS,
  MAX_RULE_RUNS_PER_PASS,
  MAX_RULE_RUNS_PER_DAY,
  MAX_ORG_RUNS_PER_DAY,
  type Condition,
  type Trigger,
} from "@/domain/automation/vocabulary";
import { conditionToSql } from "@/domain/automation/scans";
import { describeRule } from "@/domain/automation/rule-text";

const valid = (overrides: Record<string, unknown> = {}) => ({
  name: "Large invoice",
  trigger: "invoice.created",
  conditions: [{ field: "total", operator: "gt", value: "2000" }],
  action: { type: "NOTIFY_IN_APP", roles: ["OWNER"], userIds: [], severity: "INFO" },
  ...overrides,
});

describe("closed vocabulary: triggers", () => {
  it("the trigger set is exactly the spec'd event triggers plus the three scans", () => {
    expect([...EVENT_TRIGGERS]).toEqual(["customer.created", "supplier.created", "invoice.created", "invoice.sent", "invoice.paid", "payment.received", "bill.created", "bill.approved"]);
    expect([...SCAN_TRIGGERS]).toEqual(["INVOICE_OVERDUE", "BILL_DUE_SOON", "INVENTORY_BELOW_REORDER"]);
    expect(TRIGGERS).toHaveLength(11);
    expect(TRIGGERS as readonly string[]).not.toContain("automation.triggered");
    expect(TRIGGERS as readonly string[]).not.toContain("ping");
  });
  it("every trigger has a non-empty, fixed field whitelist", () => {
    for (const trigger of TRIGGERS) expect(Object.keys(TRIGGER_FIELDS[trigger]).length, trigger).toBeGreaterThan(0);
  });
});

describe("rule validation", () => {
  it("accepts a well-formed rule and normalises it", () => {
    const result = validateRuleSpec(valid());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.conditions).toEqual([{ field: "total", operator: "gt", value: "2000" }]);
      expect(result.spec.action).toMatchObject({ type: "NOTIFY_IN_APP", roles: ["OWNER"], includeAmounts: false });
    }
  });

  it.each([
    ["an unknown trigger", valid({ trigger: "invoice.deleted" })],
    ["the automation event as a trigger", valid({ trigger: "automation.triggered" })],
    ["an unknown field", valid({ conditions: [{ field: "memo", operator: "eq", value: "x" }] })],
    ["a field from another trigger", valid({ conditions: [{ field: "days_overdue", operator: "gt", value: 3 }] })],
    ["a prototype key as a field", valid({ conditions: [{ field: "__proto__", operator: "eq", value: "x" }] })],
    ["constructor as a field", valid({ conditions: [{ field: "constructor", operator: "eq", value: "x" }] })],
    ["an unknown operator", valid({ conditions: [{ field: "total", operator: "matches", value: "2000" }] })],
    ["an operator that does not fit the field kind", valid({ conditions: [{ field: "currency", operator: "gt", value: "AUD" }] })],
    ["a money value as a float", valid({ conditions: [{ field: "total", operator: "gt", value: 2000.5 }] })],
    ["a money value as a number", valid({ conditions: [{ field: "total", operator: "gt", value: 2000 }] })],
    ["a money value with too many places", valid({ conditions: [{ field: "total", operator: "gt", value: "1.23456" }] })],
    ["a money value with an expression", valid({ conditions: [{ field: "total", operator: "gt", value: "1000 OR 1=1" }] })],
    ["extra keys on a condition", valid({ conditions: [{ field: "total", operator: "gt", value: "1", sql: "x" }] })],
    ["too many conditions", valid({ conditions: Array.from({ length: MAX_CONDITIONS + 1 }, () => ({ field: "total", operator: "gt", value: "1" })) })],
    ["an unknown action", valid({ action: { type: "POST_JOURNAL" } })],
    ["approving as an action", valid({ action: { type: "APPROVE_BILL" } })],
    ["extra keys on an action", valid({ action: { type: "EMIT_WEBHOOK_EVENT", url: "https://evil.example" } })],
    ["a notify with nobody to notify", valid({ action: { type: "NOTIFY_IN_APP", roles: [], userIds: [], severity: "INFO" } })],
    ["an unknown role", valid({ action: { type: "NOTIFY_IN_APP", roles: ["SUPERUSER"], userIds: [], severity: "INFO" } })],
    ["a non-uuid user", valid({ action: { type: "NOTIFY_IN_APP", roles: [], userIds: ["not-a-uuid"], severity: "INFO" } })],
    ["a draft PO on a non-inventory trigger", valid({ action: { type: "CREATE_DRAFT_PURCHASE_ORDER" } })],
    ["an unknown top-level key", valid({ webhookUrl: "https://evil.example" })],
    ["an empty name", valid({ name: "   " })],
    ["a control character in the name", valid({ name: "bad\u0000name" })],
    ["settings on a trigger that takes none", valid({ triggerParams: { days: 3 } })],
  ])("refuses %s", (_label, input) => {
    expect(validateRuleSpec(input).ok).toBe(false);
  });

  it("refuses non-objects", () => {
    for (const bad of [null, undefined, "x", 3, [], true]) expect(validateRuleSpec(bad).ok).toBe(false);
  });

  it("treats injection-looking text as inert data: it is accepted in names/messages only as plain text and never reaches a field/operator/trigger/action position", () => {
    const hostile = "'; DROP TABLE invoices; -- ${process.env.SECRET} {{7*7}} <script>alert(1)</script> $(rm -rf /)";
    const ok = validateRuleSpec(valid({ name: hostile.slice(0, 80), description: hostile.slice(0, 250), action: { type: "NOTIFY_IN_APP", roles: ["OWNER"], userIds: [], severity: "INFO", message: hostile.slice(0, 190) } }));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      // Stored verbatim as text; there is nothing that interprets it.
      expect(ok.spec.name).toBe(hostile.slice(0, 80).trim());
    }
    // ...but in any structural position it is refused.
    expect(validateRuleSpec(valid({ trigger: hostile })).ok).toBe(false);
    expect(validateRuleSpec(valid({ conditions: [{ field: hostile, operator: "eq", value: "x" }] })).ok).toBe(false);
    expect(validateRuleSpec(valid({ conditions: [{ field: "currency", operator: hostile, value: "AUD" }] })).ok).toBe(false);
    expect(validateRuleSpec(valid({ conditions: [{ field: "currency", operator: "eq", value: hostile }] })).ok).toBe(false);
    expect(validateRuleSpec(valid({ conditions: [{ field: "customer_id", operator: "eq", value: hostile }] })).ok).toBe(false);
    expect(validateRuleSpec(valid({ action: { type: hostile } })).ok).toBe(false);
  });

  it("scan triggers require their day settings within range", () => {
    const base = { name: "n", conditions: [], action: { type: "NOTIFY_IN_APP", roles: ["OWNER"], userIds: [], severity: "INFO" } };
    expect(validateRuleSpec({ ...base, trigger: "INVOICE_OVERDUE", triggerParams: { days: 7 } }).ok).toBe(true);
    expect(validateRuleSpec({ ...base, trigger: "INVOICE_OVERDUE", triggerParams: { days: "7" } }).ok).toBe(true);
    for (const days of [0, -1, 366, 1.5, "x", null]) expect(validateRuleSpec({ ...base, trigger: "INVOICE_OVERDUE", triggerParams: { days } }).ok, String(days)).toBe(false);
    expect(validateRuleSpec({ ...base, trigger: "INVOICE_OVERDUE" }).ok).toBe(false);
    expect(validateRuleSpec({ ...base, trigger: "BILL_DUE_SOON", triggerParams: { days: 61 } }).ok).toBe(false);
    expect(validateRuleSpec({ ...base, trigger: "BILL_DUE_SOON", triggerParams: { days: 14 } }).ok).toBe(true);
    expect(validateRuleSpec({ ...base, trigger: "INVENTORY_BELOW_REORDER", triggerParams: { days: 1 } }).ok).toBe(false);
    expect(validateRuleSpec({ ...base, trigger: "INVENTORY_BELOW_REORDER" }).ok).toBe(true);
  });

  it("'in' takes a list of valid items, de-duplicated and lower-cased where it is an id", () => {
    const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const r = validateCondition("invoice.created", { field: "customer_id", operator: "in", value: [id, id.toLowerCase()] });
    expect(r.ok && r.condition.value).toEqual([id.toLowerCase()]);
    expect(validateCondition("invoice.created", { field: "customer_id", operator: "in", value: "not a list" }).ok).toBe(false);
    expect(validateCondition("invoice.created", { field: "currency", operator: "in", value: ["AUD", "usd"] }).ok).toBe(false);
    expect(validateCondition("invoice.created", { field: "currency", operator: "eq", value: ["AUD"] }).ok).toBe(false);
  });
});

describe("condition evaluation", () => {
  const c = (field: string, operator: Condition["operator"], value: Condition["value"]): Condition => ({ field, operator, value });

  it("compares money as exact decimals, never floats", () => {
    // 0.1 + 0.2 style traps: these are equal as decimals and unequal as floats.
    expect(evaluateCondition(c("total", "eq", "0.3"), { total: "0.30" }, "invoice.created")).toBe(true);
    expect(evaluateCondition(c("total", "gt", "0.1"), { total: "0.1000" }, "invoice.created")).toBe(false);
    expect(evaluateCondition(c("total", "gte", "0.1"), { total: "0.1000" }, "invoice.created")).toBe(true);
    expect(evaluateCondition(c("total", "gt", "2000"), { total: "2000.01" }, "invoice.created")).toBe(true);
    expect(evaluateCondition(c("total", "gt", "2000"), { total: "2000.00" }, "invoice.created")).toBe(false);
    expect(evaluateCondition(c("total", "lt", "9007199254740993"), { total: "9007199254740992.5" }, "invoice.created")).toBe(true); // beyond float precision
    expect(evaluateCondition(c("total", "lte", "-5.5"), { total: "-5.50" }, "invoice.created")).toBe(true);
    expect(evaluateCondition(c("total", "neq", "100"), { total: "100.0000" }, "invoice.created")).toBe(false);
  });

  it("integers, uuids, currencies and enums", () => {
    expect(evaluateCondition(c("days_overdue", "gte", 7), { days_overdue: 7 }, "INVOICE_OVERDUE")).toBe(true);
    expect(evaluateCondition(c("days_overdue", "gt", 7), { days_overdue: 7 }, "INVOICE_OVERDUE")).toBe(false);
    const id = "11111111-1111-4111-8111-111111111111";
    expect(evaluateCondition(c("customer_id", "eq", id), { customer_id: id.toUpperCase() }, "invoice.created")).toBe(true);
    expect(evaluateCondition(c("customer_id", "in", [id]), { customer_id: id }, "invoice.created")).toBe(true);
    expect(evaluateCondition(c("customer_id", "neq", id), { customer_id: id }, "invoice.created")).toBe(false);
    expect(evaluateCondition(c("currency", "in", ["AUD", "NZD"]), { currency: "NZD" }, "invoice.created")).toBe(true);
    expect(evaluateCondition(c("method", "eq", "CARD"), { method: "BANK_TRANSFER" }, "payment.received")).toBe(false);
  });

  it("a missing, null or malformed fact never matches, and it never throws", () => {
    expect(evaluateCondition(c("total", "gt", "1"), {}, "invoice.created")).toBe(false);
    expect(evaluateCondition(c("total", "gt", "1"), { total: null }, "invoice.created")).toBe(false);
    expect(evaluateCondition(c("total", "gt", "1"), { total: "not-a-number" }, "invoice.created")).toBe(false);
    expect(evaluateCondition(c("nope", "eq", "x"), { nope: "x" }, "invoice.created")).toBe(false);
    expect(evaluateCondition({ field: "total", operator: "bogus" as never, value: "1" }, { total: "5" }, "invoice.created")).toBe(false);
    expect(evaluateCondition(c("total", "gt", ["1"]), { total: "5" }, "invoice.created")).toBe(false);
  });

  it("conditions are ANDed; none means always", () => {
    const facts = { total: "2500.00", currency: "AUD" };
    expect(evaluateConditions([], facts, "invoice.created")).toBe(true);
    expect(evaluateConditions([c("total", "gt", "2000"), c("currency", "eq", "AUD")], facts, "invoice.created")).toBe(true);
    expect(evaluateConditions([c("total", "gt", "2000"), c("currency", "eq", "NZD")], facts, "invoice.created")).toBe(false);
  });

  it("facts are read only from own properties (no prototype pollution reaches a rule)", () => {
    expect(evaluateCondition(c("total", "eq", "1"), Object.create({ total: "1" }), "invoice.created")).toBe(false);
  });
});

describe("compiling scan conditions to SQL", () => {
  const dialect = new PgDialect();
  const compile = (trigger: "INVOICE_OVERDUE" | "BILL_DUE_SOON" | "INVENTORY_BELOW_REORDER", condition: Condition) => dialect.sqlToQuery(conditionToSql(trigger, condition, { today: "2026-02-01" }));

  it("values are bound parameters, never part of the SQL text", () => {
    const q = compile("INVOICE_OVERDUE", { field: "amount_due", operator: "gt", value: "123.45" });
    expect(q.sql).toMatch(/> \$\d+::numeric/);
    expect(q.sql).not.toContain("123.45");
    expect(q.params).toContain("123.45");
    const inQ = compile("INVOICE_OVERDUE", { field: "currency", operator: "in", value: ["AUD", "NZD"] });
    expect(inQ.sql).not.toMatch(/AUD|NZD/);
    expect(inQ.params).toEqual(expect.arrayContaining(["AUD", "NZD"]));
  });

  it("refuses anything outside the closed tables (a tampered rule cannot reach SQL)", () => {
    expect(() => compile("INVOICE_OVERDUE", { field: "1=1; DROP TABLE x", operator: "eq", value: "x" })).toThrow();
    expect(() => compile("INVOICE_OVERDUE", { field: "total", operator: "LIKE" as never, value: "x" })).toThrow();
    expect(() => compile("INVOICE_OVERDUE", { field: "total", operator: "gt", value: ["1"] })).toThrow();
    expect(() => compile("INVOICE_OVERDUE", { field: "quantity_on_hand", operator: "gt", value: "1" })).toThrow(); // another trigger's field
    expect(() => compile("INVOICE_OVERDUE", { field: "__proto__", operator: "eq", value: "x" })).toThrow();
  });

  it("every whitelisted scan field compiles with every operator its kind allows", () => {
    for (const trigger of SCAN_TRIGGERS) {
      for (const [field, def] of Object.entries(TRIGGER_FIELDS[trigger])) {
        for (const operator of OPERATORS) {
          const kindOk = def.kind === "decimal" || def.kind === "integer" ? operator !== "in" : ["eq", "neq", "in"].includes(operator);
          if (!kindOk) continue;
          const value = operator === "in" ? ["x"] : def.kind === "decimal" ? "1" : def.kind === "integer" ? 1 : "x";
          expect(() => compile(trigger, { field, operator, value }), `${trigger}.${field} ${operator}`).not.toThrow();
        }
      }
    }
  });
});

describe("overdue arithmetic", () => {
  const d = (s: string) => new Date(s);
  it("counts whole UTC calendar days, 0 on the due date", () => {
    expect(daysOverdue(d("2026-01-31T00:00:00Z"), d("2026-01-31T23:59:59Z"))).toBe(0);
    expect(daysOverdue(d("2026-01-31T00:00:00Z"), d("2026-02-01T00:00:00Z"))).toBe(1);
    expect(daysOverdue(d("2026-01-31T00:00:00Z"), d("2026-02-07T05:00:00Z"))).toBe(7);
    expect(daysOverdue(d("2026-01-31T00:00:00Z"), d("2026-01-30T12:00:00Z"))).toBe(-1);
  });
  it("crosses month, year and leap-day boundaries correctly", () => {
    expect(daysOverdue(d("2025-12-31T00:00:00Z"), d("2026-01-01T00:00:00Z"))).toBe(1);
    expect(daysOverdue(d("2028-02-28T00:00:00Z"), d("2028-03-01T00:00:00Z"))).toBe(2); // 2028 is a leap year
    expect(daysOverdue(d("2027-02-28T00:00:00Z"), d("2027-03-01T00:00:00Z"))).toBe(1);
    expect(daysOverdue(d("2026-01-01T00:00:00Z"), d("2027-01-01T00:00:00Z"))).toBe(365);
  });
  it("ignores the time of day of either side", () => {
    expect(daysOverdue(d("2026-03-10T23:30:00Z"), d("2026-03-11T00:30:00Z"))).toBe(1);
    expect(daysUntilDue(d("2026-03-15T00:00:00Z"), d("2026-03-10T18:00:00Z"))).toBe(5);
    expect(daysUntilDue(d("2026-03-10T00:00:00Z"), d("2026-03-10T18:00:00Z"))).toBe(0);
  });
});

describe("dedupe keys, caps and backoff", () => {
  it("derives stable, distinct keys", () => {
    expect(eventJobKey("e1")).toBe("event:e1");
    expect(overdueJobKey("i1", 7)).toBe("invoice:i1:overdue:7");
    expect(overdueJobKey("i1", 30)).not.toBe(overdueJobKey("i1", 7));
    expect(dueSoonJobKey("b1", 3)).toBe("bill:b1:due_soon:3");
    expect(reorderJobKey("p1")).toBe("reorder:p1");
  });
  it("caps are sane relative to each other", () => {
    expect(MAX_RULE_RUNS_PER_PASS).toBeLessThanOrEqual(MAX_ORG_RUNS_PER_PASS);
    expect(MAX_RULE_RUNS_PER_DAY).toBeLessThanOrEqual(MAX_ORG_RUNS_PER_DAY);
    expect(MAX_ORG_RUNS_PER_PASS).toBeLessThanOrEqual(MAX_ORG_RUNS_PER_DAY);
  });
  it("retry delays grow and the attempt cap is small", () => {
    expect(retryDelayMs(1)).toBeLessThan(retryDelayMs(2));
    expect(MAX_SEND_ATTEMPTS).toBeLessThanOrEqual(5);
    expect(MAX_SEND_ATTEMPTS).toBeGreaterThanOrEqual(2);
  });
});

describe("plain-English rendering", () => {
  it("renders a rule in the WHEN / AND / THEN form, from labels only", () => {
    const r = validateRuleSpec(valid());
    expect(r.ok).toBe(true);
    if (r.ok) expect(describeRule(r.spec)).toBe("WHEN an invoice is created AND Total is greater than 2000 THEN notify OWNER in the app");
  });
  it("every trigger renders", () => {
    for (const trigger of TRIGGERS as readonly Trigger[]) {
      const days = trigger === "INVOICE_OVERDUE" || trigger === "BILL_DUE_SOON" ? { days: 5 } : {};
      const r = validateRuleSpec({ name: "n", trigger, triggerParams: days, conditions: [], action: { type: "EMIT_WEBHOOK_EVENT" } });
      expect(r.ok, trigger).toBe(true);
      if (r.ok) expect(describeRule(r.spec)).toMatch(/^WHEN .+ THEN emit/);
    }
  });
  it("the closed action list is exactly four", () => {
    expect([...ACTION_TYPES]).toEqual(["NOTIFY_IN_APP", "SEND_TO_CHANNEL", "EMIT_WEBHOOK_EVENT", "CREATE_DRAFT_PURCHASE_ORDER"]);
  });
});
