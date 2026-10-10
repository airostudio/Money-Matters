import Decimal from "decimal.js";
import { sql, type SQL } from "drizzle-orm";
import type { TenantDb } from "@/db/tenant";
import { decimalString, isoDate, money } from "@/domain/api/dto";
import type { JobContext } from "./context";
import {
  SCAN_BATCH,
  TRIGGER_FIELDS,
  daysOverdue,
  daysUntilDue,
  dueSoonJobKey,
  evaluateConditions,
  overdueJobKey,
  reorderJobKey,
  type Condition,
  type Facts,
  type ScanTrigger,
} from "./vocabulary";

/**
 * The condition scans (Phase 10 Slice 3): deterministic, BOUNDED SQL, run inside an evaluation pass's single transaction.
 *
 *  - They only SELECT candidates that no job exists for yet (`NOT EXISTS` the rule's job for that key), so a pass examines
 *    at most `SCAN_BATCH` rows per rule and the next pass continues where this one stopped - never an unbounded scan.
 *  - A rule's conditions are COMPILED INTO the query (so rows that fail a condition cannot crowd matching rows out of the
 *    batch). The compilation is a closed lookup: the field maps to a fixed SQL expression below, the operator to a fixed
 *    SQL operator, and the value is always a BOUND PARAMETER - no user text is ever concatenated into SQL. The same
 *    conditions are then re-checked in memory with the shared evaluator, so a SQL/JS disagreement can only ever drop a row.
 *  - Money is compared as `numeric` in the database and carried as decimal strings; never a float.
 */
export interface ScanCandidate {
  jobKey: string;
  context: JobContext;
}

interface SqlCtx {
  /** Today's UTC calendar date as `YYYY-MM-DD`. */
  today: string;
}

type FieldSql = (ctx: SqlCtx) => SQL;

const OPERATOR_SQL: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

const todayDate = (ctx: SqlCtx) => sql`${ctx.today}::date`;
const INVOICE_DUE_DAY = sql.raw("(i.due_date AT TIME ZONE 'UTC')::date");
const BILL_DUE_DAY = sql.raw("(b.due_date AT TIME ZONE 'UTC')::date");

const INVOICE_DUE_EXPR = sql.raw(`(i.total - coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.invoice_id = i.id), 0))`);
const BILL_DUE_EXPR = sql.raw(`(b.total - coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a WHERE a.bill_id = b.id), 0))`);

const FIELD_SQL: Record<ScanTrigger, Record<string, FieldSql>> = {
  INVOICE_OVERDUE: {
    total: () => sql.raw("i.total"),
    amount_due: () => INVOICE_DUE_EXPR,
    days_overdue: (ctx) => sql`(${todayDate(ctx)} - ${INVOICE_DUE_DAY})`,
    customer_id: () => sql.raw("i.customer_contact_id::text"),
    currency: () => sql.raw("i.currency"),
  },
  BILL_DUE_SOON: {
    total: () => sql.raw("b.total"),
    amount_due: () => BILL_DUE_EXPR,
    days_until_due: (ctx) => sql`(${BILL_DUE_DAY} - ${todayDate(ctx)})`,
    supplier_id: () => sql.raw("b.supplier_contact_id::text"),
    currency: () => sql.raw("b.currency"),
  },
  INVENTORY_BELOW_REORDER: {
    quantity_on_hand: () => sql.raw("p.quantity_on_hand"),
    reorder_point: () => sql.raw("p.reorder_point"),
    reorder_quantity: () => sql.raw("p.reorder_quantity"),
    shortfall: () => sql.raw("(p.reorder_point - p.quantity_on_hand)"),
    supplier_id: () => sql.raw("p.preferred_supplier_contact_id::text"),
  },
};

/** Compiles ONE validated condition to a SQL predicate with bound values. Throws on anything outside the closed tables (the caller treats that as an invalid rule). */
export function conditionToSql(trigger: ScanTrigger, condition: Condition, ctx: SqlCtx): SQL {
  const fieldMap = FIELD_SQL[trigger];
  const def = Object.prototype.hasOwnProperty.call(TRIGGER_FIELDS[trigger], condition.field) ? TRIGGER_FIELDS[trigger][condition.field] : undefined;
  const make = Object.prototype.hasOwnProperty.call(fieldMap, condition.field) ? fieldMap[condition.field] : undefined;
  if (!def || !make) throw new Error(`Unknown condition field "${condition.field}".`);
  const expr = make(ctx);
  if (condition.operator === "in") {
    if (!Array.isArray(condition.value) || condition.value.length === 0) throw new Error("An 'in' condition needs a list.");
    return sql`${expr} IN (${sql.join(condition.value.map((v) => sql`${String(v)}`), sql`, `)})`;
  }
  const op = Object.prototype.hasOwnProperty.call(OPERATOR_SQL, condition.operator) ? OPERATOR_SQL[condition.operator] : undefined;
  if (!op || Array.isArray(condition.value)) throw new Error(`Unknown operator "${condition.operator}".`);
  const operator = sql.raw(op);
  if (def.kind === "decimal") return sql`${expr} ${operator} ${String(condition.value)}::numeric`;
  if (def.kind === "integer") return sql`${expr} ${operator} ${Number(condition.value)}::int`;
  return sql`${expr} ${operator} ${String(condition.value)}`;
}

function allConditions(trigger: ScanTrigger, conditions: readonly Condition[], ctx: SqlCtx): SQL {
  if (conditions.length === 0) return sql`TRUE`;
  return sql.join(conditions.map((c) => conditionToSql(trigger, c, ctx)), sql` AND `);
}

const utcToday = (now: Date) => isoDate(now);

interface DocRow {
  id: string;
  number: string;
  party_id: string;
  party_name: string;
  currency: string;
  total: string;
  amount_due: string;
  due_date: Date | string;
  status: string;
}

const asDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

/** Invoices N or more calendar days past due that still have an amount due and no job yet for this rule. */
export async function scanOverdueInvoices(tx: TenantDb, organizationId: string, ruleId: string, days: number, conditions: readonly Condition[], now: Date): Promise<ScanCandidate[]> {
  const ctx: SqlCtx = { today: utcToday(now) };
  const result = await tx.execute(sql`
    SELECT i.id, i.invoice_number AS number, i.customer_contact_id AS party_id, c.display_name AS party_name, i.currency,
           i.total::text AS total, ${INVOICE_DUE_EXPR}::text AS amount_due, i.due_date, i.status::text AS status
    FROM invoices i
    JOIN contacts c ON c.id = i.customer_contact_id
    WHERE i.organization_id = ${organizationId}
      AND i.status IN ('APPROVED', 'SENT', 'VIEWED', 'PART_PAID')
      AND ${INVOICE_DUE_EXPR} > 0
      AND (${todayDate(ctx)} - ${INVOICE_DUE_DAY}) >= ${days}::int
      AND ${allConditions("INVOICE_OVERDUE", conditions, ctx)}
      AND NOT EXISTS (
        SELECT 1 FROM automation_jobs j
        WHERE j.rule_id = ${ruleId} AND j.job_key = 'invoice:' || i.id::text || ':overdue:' || ${days}::text
      )
    ORDER BY i.due_date ASC, i.id ASC
    LIMIT ${SCAN_BATCH}`);
  const out: ScanCandidate[] = [];
  for (const row of result.rows as unknown as DocRow[]) {
    const dueDate = asDate(row.due_date);
    const total = decimalString(row.total);
    const amountDue = decimalString(row.amount_due);
    const facts: Facts = { total, amount_due: amountDue, days_overdue: daysOverdue(dueDate, now), customer_id: row.party_id, currency: row.currency };
    if (!evaluateConditions(conditions, facts, "INVOICE_OVERDUE")) continue;
    out.push({
      jobKey: overdueJobKey(row.id, days),
      context: {
        v: 1,
        trigger: "INVOICE_OVERDUE",
        source: "scan",
        eventId: null,
        objectType: "Invoice",
        objectId: row.id,
        number: row.number,
        name: row.party_name,
        currency: row.currency,
        total,
        amountDue,
        amount: null,
        dueDate: isoDate(dueDate),
        facts,
        dto: {
          id: row.id,
          number: row.number,
          status: row.status,
          due_date: isoDate(dueDate),
          currency: row.currency,
          total: money(row.total, row.currency),
          amount_due: money(row.amount_due, row.currency),
          customer: { id: row.party_id, display_name: row.party_name },
        },
      },
    });
  }
  return out;
}

/** Bills falling due within the next N days (today included) that still have an amount due and no job yet for this rule. */
export async function scanBillsDueSoon(tx: TenantDb, organizationId: string, ruleId: string, days: number, conditions: readonly Condition[], now: Date): Promise<ScanCandidate[]> {
  const ctx: SqlCtx = { today: utcToday(now) };
  const result = await tx.execute(sql`
    SELECT b.id, b.bill_number AS number, b.supplier_contact_id AS party_id, c.display_name AS party_name, b.currency,
           b.total::text AS total, ${BILL_DUE_EXPR}::text AS amount_due, b.due_date, b.status::text AS status
    FROM bills b
    JOIN contacts c ON c.id = b.supplier_contact_id
    WHERE b.organization_id = ${organizationId}
      AND b.status IN ('APPROVED', 'PART_PAID')
      AND ${BILL_DUE_EXPR} > 0
      AND (${BILL_DUE_DAY} - ${todayDate(ctx)}) BETWEEN 0 AND ${days}::int
      AND ${allConditions("BILL_DUE_SOON", conditions, ctx)}
      AND NOT EXISTS (
        SELECT 1 FROM automation_jobs j
        WHERE j.rule_id = ${ruleId} AND j.job_key = 'bill:' || b.id::text || ':due_soon:' || ${days}::text
      )
    ORDER BY b.due_date ASC, b.id ASC
    LIMIT ${SCAN_BATCH}`);
  const out: ScanCandidate[] = [];
  for (const row of result.rows as unknown as DocRow[]) {
    const dueDate = asDate(row.due_date);
    const total = decimalString(row.total);
    const amountDue = decimalString(row.amount_due);
    const facts: Facts = { total, amount_due: amountDue, days_until_due: daysUntilDue(dueDate, now), supplier_id: row.party_id, currency: row.currency };
    if (!evaluateConditions(conditions, facts, "BILL_DUE_SOON")) continue;
    out.push({
      jobKey: dueSoonJobKey(row.id, days),
      context: {
        v: 1,
        trigger: "BILL_DUE_SOON",
        source: "scan",
        eventId: null,
        objectType: "Bill",
        objectId: row.id,
        number: row.number,
        name: row.party_name,
        currency: row.currency,
        total,
        amountDue,
        amount: null,
        dueDate: isoDate(dueDate),
        facts,
        dto: {
          id: row.id,
          number: row.number,
          status: row.status,
          due_date: isoDate(dueDate),
          currency: row.currency,
          total: money(row.total, row.currency),
          amount_due: money(row.amount_due, row.currency),
          supplier: { id: row.party_id, display_name: row.party_name },
        },
      },
    });
  }
  return out;
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  quantity_on_hand: string;
  reorder_point: string;
  reorder_quantity: string | null;
  supplier_id: string | null;
}

/**
 * Active tracked products at or below their reorder point with no job yet. At-or-below (`<=`) deliberately matches the
 * existing Reorder Alerts page (`ReorderAlertService`), so the two never disagree about which products need ordering.
 */
export async function scanBelowReorder(tx: TenantDb, organizationId: string, ruleId: string, conditions: readonly Condition[], now: Date): Promise<ScanCandidate[]> {
  const ctx: SqlCtx = { today: utcToday(now) };
  const result = await tx.execute(sql`
    SELECT p.id, p.sku, p.name, p.quantity_on_hand::text AS quantity_on_hand, p.reorder_point::text AS reorder_point,
           p.reorder_quantity::text AS reorder_quantity, p.preferred_supplier_contact_id AS supplier_id
    FROM products p
    WHERE p.organization_id = ${organizationId}
      AND p.type = 'TRACKED_INVENTORY'
      AND p.is_active
      AND p.reorder_point IS NOT NULL
      AND p.quantity_on_hand <= p.reorder_point
      AND ${allConditions("INVENTORY_BELOW_REORDER", conditions, ctx)}
      AND NOT EXISTS (SELECT 1 FROM automation_jobs j WHERE j.rule_id = ${ruleId} AND j.job_key = 'reorder:' || p.id::text)
    ORDER BY p.sku ASC, p.id ASC
    LIMIT ${SCAN_BATCH}`);
  const out: ScanCandidate[] = [];
  for (const row of result.rows as unknown as ProductRow[]) {
    const qty = decimalString(row.quantity_on_hand);
    const point = decimalString(row.reorder_point);
    const reorderQty = row.reorder_quantity === null ? null : decimalString(row.reorder_quantity);
    const shortfall = decimalString(new Decimal(row.reorder_point).minus(row.quantity_on_hand).toString());
    const facts: Facts = { quantity_on_hand: qty, reorder_point: point, reorder_quantity: reorderQty, shortfall, supplier_id: row.supplier_id };
    if (!evaluateConditions(conditions, facts, "INVENTORY_BELOW_REORDER")) continue;
    out.push({
      jobKey: reorderJobKey(row.id),
      context: {
        v: 1,
        trigger: "INVENTORY_BELOW_REORDER",
        source: "scan",
        eventId: null,
        objectType: "Product",
        objectId: row.id,
        number: row.sku,
        name: row.name,
        currency: null,
        total: null,
        amountDue: null,
        amount: null,
        dueDate: null,
        facts,
        // Products are not part of the public API, so an emitted webhook event carries the product id only.
        dto: null,
      },
    });
  }
  return out;
}

/**
 * RE-ARMING. A reorder job is a "this product has already fired" marker. It is deleted - so the product can fire again -
 * when the product has recovered above its reorder point (or stopped being a tracked, active product with a reorder
 * point), and, for a job that was SKIPPED only because the product lacked a preferred supplier or reorder quantity, once
 * that has been fixed. In-flight jobs (CLAIMED / RETRY) are never touched. Bounded by a sub-select limit.
 */
export async function rearmReorderJobs(tx: TenantDb, organizationId: string, ruleId: string, needsOrderDetails: boolean): Promise<number> {
  const result = await tx.execute(sql`
    DELETE FROM automation_jobs
    WHERE id IN (
      SELECT j.id
      FROM automation_jobs j
      JOIN products p ON j.job_key = 'reorder:' || p.id::text AND p.organization_id = j.organization_id
      WHERE j.rule_id = ${ruleId}
        AND j.organization_id = ${organizationId}
        AND j.state IN ('DONE', 'SKIPPED', 'FAILED')
        AND (
          NOT (p.type = 'TRACKED_INVENTORY' AND p.is_active AND p.reorder_point IS NOT NULL AND p.quantity_on_hand <= p.reorder_point)
          OR (${needsOrderDetails} AND j.state = 'SKIPPED' AND p.preferred_supplier_contact_id IS NOT NULL AND coalesce(p.reorder_quantity, 0) > 0)
        )
      LIMIT 200
    )`);
  return result.rowCount ?? 0;
}
