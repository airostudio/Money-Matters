import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { verifyPlatformAdmin } from "./identity";

/**
 * Read-only directory of organizations and users for the platform admin —
 * non-tenant tables only (users, organizations, organization_memberships).
 * Nothing here can reveal a customer's books. See the boundary test in
 * src/tests/unit/platform-admin/boundary.test.ts.
 */

export type SeatFilter = "all" | "full" | "over";

export interface DirectoryQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  seats?: SeatFilter;
}

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  planTier: string;
  seatLimit: number;
  seatsUsed: number;
  memberCount: number;
  createdAt: Date;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  disabledAt: Date | null;
  organizations: Array<{ id: string; name: string; slug: string; role: string }>;
}

type Rows<T> = { rows: T[] };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paging(query: DirectoryQuery) {
  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 200);
  const page = Math.max(Math.floor(query.page ?? 1), 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Escapes LIKE wildcards so a search for "100%" matches literally. */
function likePattern(q: string | undefined): string | null {
  const trimmed = (q ?? "").trim();
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const ORG_SEATS_CTE = sql`
  seats AS (
    SELECT o.id, o.name, o.slug, o.plan_tier::text AS plan_tier, o.seat_limit, o.created_at,
           (count(m.id) FILTER (WHERE m.is_active))::int AS used
    FROM organizations o
    LEFT JOIN organization_memberships m ON m.organization_id = o.id
    GROUP BY o.id
  )
`;

function orgWhere(query: DirectoryQuery) {
  const pattern = likePattern(query.q);
  const parts = [sql`true`];
  if (pattern) parts.push(sql`(name ILIKE ${pattern} OR slug ILIKE ${pattern})`);
  if (query.seats === "full") parts.push(sql`used >= seat_limit`);
  if (query.seats === "over") parts.push(sql`used > seat_limit`);
  return sql.join(parts, sql` AND `);
}

function mapOrg(r: {
  id: string;
  name: string;
  slug: string;
  plan_tier: string;
  seat_limit: number;
  used: number;
  created_at: Date;
}): OrganizationRow {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    planTier: r.plan_tier,
    seatLimit: r.seat_limit,
    seatsUsed: r.used,
    memberCount: r.used,
    createdAt: new Date(r.created_at),
  };
}

type OrgSqlRow = Parameters<typeof mapOrg>[0];

export const DirectoryService = {
  async listOrganizations(adminUserId: string, query: DirectoryQuery = {}) {
    await verifyPlatformAdmin(adminUserId);
    const { page, pageSize, offset } = paging(query);
    const where = orgWhere(query);

    const rows = (await db.execute(sql`
      WITH ${ORG_SEATS_CTE}
      SELECT * FROM seats WHERE ${where}
      ORDER BY created_at DESC, id
      LIMIT ${pageSize} OFFSET ${offset}
    `)) as unknown as Rows<OrgSqlRow>;
    const total = (await db.execute(sql`
      WITH ${ORG_SEATS_CTE}
      SELECT count(*)::int AS n FROM seats WHERE ${where}
    `)) as unknown as Rows<{ n: number }>;

    return { rows: rows.rows.map(mapOrg), total: total.rows[0]?.n ?? 0, page, pageSize };
  },

  /** Every organization matching the query, unpaginated — for the CSV export (directory data only). */
  async exportOrganizations(adminUserId: string, query: DirectoryQuery = {}) {
    await verifyPlatformAdmin(adminUserId);
    const rows = (await db.execute(sql`
      WITH ${ORG_SEATS_CTE}
      SELECT * FROM seats WHERE ${orgWhere(query)} ORDER BY created_at DESC, id
    `)) as unknown as Rows<OrgSqlRow>;
    return rows.rows.map(mapOrg);
  },

  async getOrganization(adminUserId: string, organizationId: string) {
    await verifyPlatformAdmin(adminUserId);
    if (!UUID_PATTERN.test(organizationId)) return null;

    const orgRows = (await db.execute(sql`
      WITH ${ORG_SEATS_CTE}
      SELECT * FROM seats WHERE id = ${organizationId}
    `)) as unknown as Rows<OrgSqlRow>;
    const org = orgRows.rows[0];
    if (!org) return null;

    const members = (await db.execute(sql`
      SELECT m.id AS membership_id, m.role::text AS role, m.is_active, m.created_at, m.updated_at,
             u.id AS user_id, u.email, u.name, u.disabled_at
      FROM organization_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${organizationId}
      ORDER BY m.is_active DESC, m.created_at
    `)) as unknown as Rows<{
      membership_id: string;
      role: string;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
      user_id: string;
      email: string;
      name: string;
      disabled_at: Date | null;
    }>;

    return {
      ...mapOrg(org),
      members: members.rows.map((m) => ({
        membershipId: m.membership_id,
        role: m.role,
        isActive: m.is_active,
        joinedAt: new Date(m.created_at),
        updatedAt: new Date(m.updated_at),
        userId: m.user_id,
        email: m.email,
        name: m.name,
        suspended: m.disabled_at !== null,
      })),
    };
  },

  async listUsers(adminUserId: string, query: DirectoryQuery = {}) {
    await verifyPlatformAdmin(adminUserId);
    const { page, pageSize, offset } = paging(query);
    const pattern = likePattern(query.q);
    const where = pattern ? sql`(u.email ILIKE ${pattern} OR u.name ILIKE ${pattern})` : sql`true`;

    const rows = (await db.execute(sql`
      SELECT u.id, u.email, u.name, u.created_at, u.disabled_at,
             coalesce(
               json_agg(json_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'role', m.role::text)
                        ORDER BY o.name) FILTER (WHERE o.id IS NOT NULL),
               '[]'::json
             ) AS organizations
      FROM users u
      LEFT JOIN organization_memberships m ON m.user_id = u.id AND m.is_active
      LEFT JOIN organizations o ON o.id = m.organization_id
      WHERE ${where}
      GROUP BY u.id
      ORDER BY u.created_at DESC, u.id
      LIMIT ${pageSize} OFFSET ${offset}
    `)) as unknown as Rows<{
      id: string;
      email: string;
      name: string;
      created_at: Date;
      disabled_at: Date | null;
      organizations: UserRow["organizations"];
    }>;
    const total = (await db.execute(sql`
      SELECT count(*)::int AS n FROM users u WHERE ${where}
    `)) as unknown as Rows<{ n: number }>;

    return {
      rows: rows.rows.map(
        (r): UserRow => ({
          id: r.id,
          email: r.email,
          name: r.name,
          createdAt: new Date(r.created_at),
          disabledAt: r.disabled_at ? new Date(r.disabled_at) : null,
          organizations: r.organizations,
        }),
      ),
      total: total.rows[0]?.n ?? 0,
      page,
      pageSize,
    };
  },

  async exportUsers(adminUserId: string, query: DirectoryQuery = {}) {
    // Same query, one big page — directory data only.
    const first = await DirectoryService.listUsers(adminUserId, { ...query, page: 1, pageSize: 200 });
    const all = [...first.rows];
    for (let page = 2; all.length < first.total; page++) {
      const next = await DirectoryService.listUsers(adminUserId, { ...query, page, pageSize: 200 });
      if (next.rows.length === 0) break;
      all.push(...next.rows);
    }
    return all;
  },

  async getUser(adminUserId: string, userId: string) {
    await verifyPlatformAdmin(adminUserId);
    if (!UUID_PATTERN.test(userId)) return null;

    const userRows = (await db.execute(sql`
      SELECT id, email, name, created_at, disabled_at FROM users WHERE id = ${userId}
    `)) as unknown as Rows<{ id: string; email: string; name: string; created_at: Date; disabled_at: Date | null }>;
    const user = userRows.rows[0];
    if (!user) return null;

    const memberships = (await db.execute(sql`
      SELECT m.id AS membership_id, m.role::text AS role, m.is_active, m.created_at,
             o.id AS organization_id, o.name, o.slug
      FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ${userId}
      ORDER BY m.is_active DESC, o.name
    `)) as unknown as Rows<{
      membership_id: string;
      role: string;
      is_active: boolean;
      created_at: Date;
      organization_id: string;
      name: string;
      slug: string;
    }>;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: new Date(user.created_at),
      disabledAt: user.disabled_at ? new Date(user.disabled_at) : null,
      memberships: memberships.rows.map((m) => ({
        membershipId: m.membership_id,
        role: m.role,
        isActive: m.is_active,
        joinedAt: new Date(m.created_at),
        organizationId: m.organization_id,
        organizationName: m.name,
        organizationSlug: m.slug,
      })),
    };
  },
};
