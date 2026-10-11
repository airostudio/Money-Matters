import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import type { Actor } from "@/domain/permissions/permission-service";
import {
  SEARCH_KINDS,
  SEARCH_KIND_SPECS,
  searchableKindsFor,
  type SearchKind,
} from "./entities";
import type { SearchGroup, SearchResultItem, SearchResponse } from "./types";
import { PER_KIND_LIMIT, likePatterns, normaliseQuery, parseAmountQuery, type LikePatterns } from "./query";

/**
 * Global search (master spec s.56). On demand only: it runs when a person types in the palette, never as part of
 * rendering a page.
 *
 * Cost, by construction:
 *  - ONE database statement for all entity types (a UNION ALL of per-type sub-selects, each with its own hard
 *    LIMIT), inside ONE tenant transaction. Round trips are the cost that matters against a pooled remote database,
 *    so this is 1 query, not one per type. Total on the wire: BEGIN, set_config(org), set_config(timeout), the
 *    SELECT, COMMIT = 5 statements (the route adds the 3 session / membership lookups every request makes).
 *  - A sub-select exists only for the types the actor's role may read (searchableKindsFor), so a type the role
 *    cannot read is never queried: not queried-and-filtered. No permitted type = no database work at all.
 *  - The query text is only ever a bound parameter; LIKE wildcards in it are escaped (query.ts).
 *  - A statement_timeout bounds a pathological scan so one keystroke cannot hold a pooled connection.
 *
 * Matching is case-insensitive prefix/substring (ILIKE) on the columns each list page already shows, tenant-scoped
 * by `organization_id` (leading column of the existing indexes) and by row-level security. No trigram index is
 * added: see docs/architecture.md (Global search) for the measured per-org scan cost and the documented limit.
 *
 * PII: every sub-select names its columns. Employees return name and status only (never TFN, bank, pay or leave
 * data); contacts return name and email, exactly what their list pages show.
 */

export type { SearchGroup, SearchResultItem, SearchResponse };

export class SearchNotAllowedError extends Error {
  constructor() {
    super("Search is available to signed-in people only.");
    this.name = "SearchNotAllowedError";
  }
}

/** Upper bound on one search statement. Generous for a LIMIT-5-per-type read; a runaway scan is cut off. */
const STATEMENT_TIMEOUT_MS = 3000;

interface BranchColumns {
  ord: number;
  kind: SearchKind;
  id: SQL;
  title: SQL;
  subtitle: SQL;
  detail: SQL;
  amount: SQL;
  currency: SQL;
  ref: SQL;
}

const NULL_TEXT = sql`NULL::text`;

const like = (column: SQL, pattern: string): SQL => sql`${column} ILIKE ${pattern} ESCAPE '!'`;
const anyOf = (parts: SQL[]): SQL => sql.join(parts, sql` OR `);

interface BranchInput {
  cols: BranchColumns;
  from: SQL;
  where: SQL;
  searchColumns: SQL[];
  /**
   * The foreign key to `contacts` for documents that also match on the contact's name (alias `c` in `from`). Matched
   * with an IN sub-select (a hashed semi-join) rather than an OR across the join, which would force a join of every
   * document row before filtering.
   */
  viaContact?: { foreignKey: SQL; orgId: string };
  /** A money column that matches when the query is an amount. */
  amountColumn?: SQL;
  /** Bank transactions store withdrawals negative: an amount query matches either sign. */
  bothSigns?: boolean;
  orderBy: SQL;
}

function buildBranch(b: BranchInput, p: LikePatterns, amount: string | null): SQL {
  let amountCondition: SQL | null = null;
  if (amount !== null && b.amountColumn) {
    amountCondition = b.bothSigns
      ? sql`abs(${b.amountColumn}) = ${amount}::numeric`
      : sql`${b.amountColumn} = ${amount}::numeric`;
  }
  const byContact = b.viaContact
    ? sql`${b.viaContact.foreignKey} IN (SELECT mc.id FROM contacts mc WHERE mc.organization_id = ${b.viaContact.orgId} AND ${like(sql`mc.display_name`, p.contains)})`
    : null;
  const matches = anyOf([
    ...b.searchColumns.map((c) => like(c, p.contains)),
    ...(byContact ? [byContact] : []),
    ...(amountCondition ? [amountCondition] : []),
  ]);
  const prefixHit = anyOf([
    ...b.searchColumns.map((c) => like(c, p.prefix)),
    ...(b.viaContact ? [like(sql`c.display_name`, p.prefix)] : []),
    ...(amountCondition ? [amountCondition] : []),
  ]);
  const c = b.cols;
  return sql`(SELECT ${c.ord}::int AS ord, ${c.kind}::text AS kind, ${c.id}::text AS id, ${c.title}::text AS title,
      ${c.subtitle}::text AS subtitle, ${c.detail}::text AS detail, ${c.amount}::text AS amount,
      ${c.currency}::text AS currency, ${c.ref}::text AS ref,
      (CASE WHEN ${prefixHit} THEN 0 ELSE 1 END) AS rank
    FROM ${b.from} WHERE ${b.where} AND (${matches}) ORDER BY rank, ${b.orderBy} LIMIT ${PER_KIND_LIMIT})`;
}

/** Builds the sub-select for one kind. Every fragment here is a constant; only the bound parameters vary. */
function branchFor(kind: SearchKind, orgId: string, p: LikePatterns, amount: string | null): SQL {
  const ord = SEARCH_KINDS.indexOf(kind);
  const base = { ord, kind };
  switch (kind) {
    case "customer":
    case "supplier": {
      const kinds = kind === "customer" ? sql`('CUSTOMER', 'BOTH')` : sql`('SUPPLIER', 'BOTH')`;
      return buildBranch(
        {
          cols: { ...base, id: sql`c.id`, title: sql`c.display_name`, subtitle: sql`c.email`, detail: NULL_TEXT, amount: NULL_TEXT, currency: NULL_TEXT, ref: NULL_TEXT },
          from: sql`contacts c`,
          where: sql`c.organization_id = ${orgId} AND c.is_active AND c.kind IN ${kinds}`,
          searchColumns: [sql`c.display_name`, sql`c.email`],
          orderBy: sql`lower(c.display_name), c.id`,
        },
        p,
        amount,
      );
    }
    case "invoice":
      return buildBranch(
        {
          cols: { ...base, id: sql`i.id`, title: sql`i.invoice_number`, subtitle: sql`c.display_name`, detail: sql`i.status`, amount: sql`i.total`, currency: sql`i.currency`, ref: NULL_TEXT },
          from: sql`invoices i JOIN contacts c ON c.id = i.customer_contact_id`,
          where: sql`i.organization_id = ${orgId}`,
          searchColumns: [sql`i.invoice_number`],
          viaContact: { foreignKey: sql`i.customer_contact_id`, orgId },
          amountColumn: sql`i.total`,
          orderBy: sql`i.issue_date DESC, i.id`,
        },
        p,
        amount,
      );
    case "quote":
      return buildBranch(
        {
          cols: { ...base, id: sql`q.id`, title: sql`q.quote_number`, subtitle: sql`c.display_name`, detail: sql`q.status`, amount: sql`q.total`, currency: sql`q.currency`, ref: NULL_TEXT },
          from: sql`quotes q JOIN contacts c ON c.id = q.customer_contact_id`,
          where: sql`q.organization_id = ${orgId}`,
          searchColumns: [sql`q.quote_number`],
          viaContact: { foreignKey: sql`q.customer_contact_id`, orgId },
          amountColumn: sql`q.total`,
          orderBy: sql`q.issue_date DESC, q.id`,
        },
        p,
        amount,
      );
    case "bill":
      return buildBranch(
        {
          cols: { ...base, id: sql`b.id`, title: sql`b.bill_number`, subtitle: sql`c.display_name`, detail: sql`b.status`, amount: sql`b.total`, currency: sql`b.currency`, ref: NULL_TEXT },
          from: sql`bills b JOIN contacts c ON c.id = b.supplier_contact_id`,
          where: sql`b.organization_id = ${orgId}`,
          searchColumns: [sql`b.bill_number`, sql`b.supplier_reference`],
          viaContact: { foreignKey: sql`b.supplier_contact_id`, orgId },
          amountColumn: sql`b.total`,
          orderBy: sql`b.issue_date DESC, b.id`,
        },
        p,
        amount,
      );
    case "purchase_order":
      return buildBranch(
        {
          cols: { ...base, id: sql`o.id`, title: sql`o.po_number`, subtitle: sql`c.display_name`, detail: sql`o.status`, amount: sql`o.total`, currency: sql`o.currency`, ref: NULL_TEXT },
          from: sql`purchase_orders o JOIN contacts c ON c.id = o.supplier_contact_id`,
          where: sql`o.organization_id = ${orgId}`,
          searchColumns: [sql`o.po_number`],
          viaContact: { foreignKey: sql`o.supplier_contact_id`, orgId },
          amountColumn: sql`o.total`,
          orderBy: sql`o.issue_date DESC, o.id`,
        },
        p,
        amount,
      );
    case "account":
      return buildBranch(
        {
          cols: { ...base, id: sql`a.id`, title: sql`a.code || ' ' || a.name`, subtitle: sql`a.type`, detail: NULL_TEXT, amount: NULL_TEXT, currency: NULL_TEXT, ref: NULL_TEXT },
          from: sql`accounts a`,
          where: sql`a.organization_id = ${orgId} AND a.is_active`,
          searchColumns: [sql`a.code`, sql`a.name`],
          orderBy: sql`a.code`,
        },
        p,
        amount,
      );
    case "payment":
      return buildBranch(
        {
          cols: { ...base, id: sql`pay.id`, title: sql`COALESCE(pay.reference, 'Payment')`, subtitle: sql`c.display_name`, detail: sql`pay.payment_date::date`, amount: sql`pay.amount`, currency: sql`pay.currency`, ref: sql`c.id` },
          from: sql`payments pay JOIN contacts c ON c.id = pay.customer_contact_id`,
          where: sql`pay.organization_id = ${orgId}`,
          searchColumns: [sql`pay.reference`],
          amountColumn: sql`pay.amount`,
          orderBy: sql`pay.payment_date DESC, pay.id`,
        },
        p,
        amount,
      );
    case "supplier_payment":
      return buildBranch(
        {
          cols: { ...base, id: sql`sp.id`, title: sql`COALESCE(sp.reference, 'Payment')`, subtitle: sql`c.display_name`, detail: sql`sp.payment_date::date`, amount: sql`sp.amount`, currency: sql`sp.currency`, ref: sql`c.id` },
          from: sql`supplier_payments sp JOIN contacts c ON c.id = sp.supplier_contact_id`,
          where: sql`sp.organization_id = ${orgId}`,
          searchColumns: [sql`sp.reference`],
          amountColumn: sql`sp.amount`,
          orderBy: sql`sp.payment_date DESC, sp.id`,
        },
        p,
        amount,
      );
    case "employee":
      // Name and employment status ONLY. No tax file number, bank, super, pay or leave column is ever selected.
      return buildBranch(
        {
          cols: { ...base, id: sql`e.id`, title: sql`e.name`, subtitle: NULL_TEXT, detail: sql`e.status`, amount: NULL_TEXT, currency: NULL_TEXT, ref: NULL_TEXT },
          from: sql`employees e`,
          where: sql`e.organization_id = ${orgId}`,
          searchColumns: [sql`e.name`],
          orderBy: sql`lower(e.name), e.id`,
        },
        p,
        amount,
      );
    case "bank_transaction":
      // Only UNMATCHED transactions: those are the ones the bank account page lists.
      return buildBranch(
        {
          cols: { ...base, id: sql`t.id`, title: sql`t.description`, subtitle: sql`ba.name`, detail: sql`t.posted_date::date`, amount: sql`t.amount`, currency: sql`t.currency`, ref: sql`t.bank_account_id` },
          from: sql`bank_transactions t JOIN bank_accounts ba ON ba.id = t.bank_account_id`,
          where: sql`t.organization_id = ${orgId} AND t.status = 'UNMATCHED'`,
          searchColumns: [sql`t.description`],
          amountColumn: sql`t.amount`,
          bothSigns: true,
          orderBy: sql`t.posted_date DESC, t.id`,
        },
        p,
        amount,
      );
    case "project":
      return buildBranch(
        {
          cols: { ...base, id: sql`pr.id`, title: sql`pr.name`, subtitle: sql`pr.code`, detail: sql`pr.status`, amount: NULL_TEXT, currency: NULL_TEXT, ref: NULL_TEXT },
          from: sql`projects pr`,
          where: sql`pr.organization_id = ${orgId}`,
          searchColumns: [sql`pr.code`, sql`pr.name`],
          orderBy: sql`lower(pr.name), pr.id`,
        },
        p,
        amount,
      );
    case "product":
      return buildBranch(
        {
          cols: { ...base, id: sql`pd.id`, title: sql`pd.name`, subtitle: sql`pd.sku`, detail: sql`pd.type`, amount: NULL_TEXT, currency: NULL_TEXT, ref: NULL_TEXT },
          from: sql`products pd`,
          where: sql`pd.organization_id = ${orgId}`,
          searchColumns: [sql`pd.sku`, sql`pd.name`],
          orderBy: sql`lower(pd.name), pd.id`,
        },
        p,
        amount,
      );
  }
}

/** "1100.0000" -> "1,100.00"; "12.3456" -> "12.3456" (nothing is rounded away). String maths only: money is never a float. */
export function formatAmountText(value: string): string {
  const negative = value.startsWith("-");
  const [whole = "0", frac = ""] = value.replace("-", "").split(".");
  const trimmed = frac.replace(/0+$/, "");
  const decimals = trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${decimals}`;
}

function humanise(value: string): string {
  const text = value.toLowerCase().replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface RawRow {
  ord: number;
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  detail: string | null;
  amount: string | null;
  currency: string | null;
  ref: string | null;
}

export function toResultItem(orgSlug: string, row: RawRow): SearchResultItem {
  const kind = row.kind as SearchKind;
  const spec = SEARCH_KIND_SPECS[kind];
  const detail = row.detail ? (/^\d{4}-\d{2}-\d{2}$/.test(row.detail) ? row.detail : humanise(row.detail)) : null;
  const money = row.amount ? `${formatAmountText(row.amount)}${row.currency ? ` ${row.currency}` : ""}` : null;
  return {
    id: row.id,
    kind,
    title: row.title,
    subtitle: [row.subtitle, detail, money].filter((part): part is string => Boolean(part)).join(" - "),
    href: `/${orgSlug}${spec.href({ id: row.id, ref: row.ref })}`,
  };
}

export const SearchService = {
  /**
   * Searches the kinds the actor may read. `orgSlug` is only used to build links. Human actors only: an API key,
   * OAuth, AI or automation actor is refused (it has the public API and its own read models for this).
   */
  async search(actor: Actor, orgSlug: string, rawQuery: unknown): Promise<SearchResponse> {
    if ((actor.type ?? "HUMAN") !== "HUMAN") throw new SearchNotAllowedError();
    const query = normaliseQuery(rawQuery);
    if (!query) return { query: "", groups: [] };

    const kinds = searchableKindsFor(actor.role, actor.grantedPermissions);
    if (kinds.length === 0) return { query, groups: [] };

    const patterns = likePatterns(query);
    const amount = parseAmountQuery(query);
    const branches = kinds.map((k) => branchFor(k, actor.organizationId, patterns, amount));
    const statement = sql`SELECT * FROM (${sql.join(branches, sql` UNION ALL `)}) u ORDER BY u.ord, u.rank, lower(u.title), u.id`;

    const rows = await withTenant(actor.organizationId, async (tx) => {
      // One statement: bound the scan, and skip JIT compilation (its fixed cost dwarfs a LIMIT-5 read).
      await tx.execute(sql`SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true), set_config('jit', 'off', true)`);
      const result = await tx.execute(statement);
      return result.rows as unknown as RawRow[];
    });

    const byKind = new Map<SearchKind, SearchResultItem[]>();
    for (const row of rows) {
      const item = toResultItem(orgSlug, row);
      const list = byKind.get(item.kind) ?? [];
      list.push(item);
      byKind.set(item.kind, list);
    }
    const groups: SearchGroup[] = [];
    for (const kind of kinds) {
      const items = byKind.get(kind);
      if (items?.length) groups.push({ kind, label: SEARCH_KIND_SPECS[kind].label, items });
    }
    return { query, groups };
  },
};

