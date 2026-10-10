import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { verifyPlatformAdmin } from "./identity";

/**
 * Platform business metrics (SaaS-level only). Derived EXCLUSIVELY from the
 * non-tenant tables — users, organizations, organization_memberships — so the
 * admin section never reads any customer's books. Aggregation is done in SQL
 * and the queries run sequentially (a few cheap statements, never a
 * Promise.all fan-out): Supabase's session pooler caps the whole project at
 * ~15 clients — see src/db/client.ts.
 */

export interface PlatformMetrics {
  users: { total: number; active: number; suspended: number };
  organizations: { total: number; archived: number };
  seats: {
    used: number;
    allowed: number;
    orgsAtLimit: number;
    /** Grandfathered/over-limit: more active members than the limit (cannot normally happen). */
    orgsOverLimit: number;
  };
  planTiers: Array<{ planTier: string; organizations: number }>;
  signupsPerWeek: Array<{ period: string; users: number }>;
  signupsPerMonth: Array<{ period: string; users: number }>;
  recentSignups: Array<{ id: string; email: string; name: string; createdAt: Date; disabledAt: Date | null }>;
  recentlySuspended: Array<{ id: string; email: string; name: string; disabledAt: Date }>;
  orgsAtOrOverLimit: Array<{
    id: string;
    name: string;
    slug: string;
    planTier: string;
    seatLimit: number;
    seatsUsed: number;
  }>;
}

type Rows<T> = { rows: T[] };

export const MetricsService = {
  async getPlatformMetrics(adminUserId: string): Promise<PlatformMetrics> {
    await verifyPlatformAdmin(adminUserId);

    const userCounts = await db.execute(sql`
      SELECT count(*)::int AS total,
             (count(*) FILTER (WHERE disabled_at IS NULL))::int AS active,
             (count(*) FILTER (WHERE disabled_at IS NOT NULL))::int AS suspended
      FROM users
    `) as unknown as Rows<{ total: number; active: number; suspended: number }>;

    const seatCounts = await db.execute(sql`
      WITH seats AS (
        SELECT o.id, o.seat_limit, o.archived_at,
               (count(m.id) FILTER (WHERE m.is_active))::int AS used
        FROM organizations o
        LEFT JOIN organization_memberships m ON m.organization_id = o.id
        GROUP BY o.id, o.seat_limit, o.archived_at
      )
      SELECT count(*)::int AS organizations,
             (count(*) FILTER (WHERE archived_at IS NOT NULL))::int AS archived,
             coalesce(sum(used), 0)::int AS used,
             coalesce(sum(seat_limit), 0)::int AS allowed,
             (count(*) FILTER (WHERE used >= seat_limit))::int AS at_limit,
             (count(*) FILTER (WHERE used > seat_limit))::int AS over_limit
      FROM seats
    `) as unknown as Rows<{ organizations: number; archived: number; used: number; allowed: number; at_limit: number; over_limit: number }>;

    const tiers = await db.execute(sql`
      SELECT plan_tier::text AS plan_tier, count(*)::int AS organizations
      FROM organizations GROUP BY plan_tier ORDER BY plan_tier
    `) as unknown as Rows<{ plan_tier: string; organizations: number }>;

    const weekly = await db.execute(sql`
      SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS period,
             count(*)::int AS users
      FROM users
      WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'UTC') - interval '11 weeks'
      GROUP BY 1 ORDER BY 1
    `) as unknown as Rows<{ period: string; users: number }>;

    const monthly = await db.execute(sql`
      SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS period,
             count(*)::int AS users
      FROM users
      WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') - interval '11 months'
      GROUP BY 1 ORDER BY 1
    `) as unknown as Rows<{ period: string; users: number }>;

    const recent = await db.execute(sql`
      SELECT id, email, name, created_at, disabled_at
      FROM users ORDER BY created_at DESC LIMIT 10
    `) as unknown as Rows<{ id: string; email: string; name: string; created_at: Date; disabled_at: Date | null }>;

    const suspended = await db.execute(sql`
      SELECT id, email, name, disabled_at
      FROM users WHERE disabled_at IS NOT NULL ORDER BY disabled_at DESC LIMIT 10
    `) as unknown as Rows<{ id: string; email: string; name: string; disabled_at: Date }>;

    const atLimit = await db.execute(sql`
      SELECT o.id, o.name, o.slug, o.plan_tier::text AS plan_tier, o.seat_limit,
             (count(m.id) FILTER (WHERE m.is_active))::int AS used
      FROM organizations o
      LEFT JOIN organization_memberships m ON m.organization_id = o.id
      GROUP BY o.id
      HAVING count(m.id) FILTER (WHERE m.is_active) >= o.seat_limit
      ORDER BY o.created_at DESC
      LIMIT 25
    `) as unknown as Rows<{
      id: string;
      name: string;
      slug: string;
      plan_tier: string;
      seat_limit: number;
      used: number;
    }>;

    const u = userCounts.rows[0] ?? { total: 0, active: 0, suspended: 0 };
    const s = seatCounts.rows[0] ?? { organizations: 0, archived: 0, used: 0, allowed: 0, at_limit: 0, over_limit: 0 };

    return {
      users: { total: u.total, active: u.active, suspended: u.suspended },
      organizations: { total: s.organizations, archived: s.archived },
      seats: { used: s.used, allowed: s.allowed, orgsAtLimit: s.at_limit, orgsOverLimit: s.over_limit },
      planTiers: tiers.rows.map((r) => ({ planTier: r.plan_tier, organizations: r.organizations })),
      signupsPerWeek: weekly.rows,
      signupsPerMonth: monthly.rows,
      recentSignups: recent.rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        createdAt: new Date(r.created_at),
        disabledAt: r.disabled_at ? new Date(r.disabled_at) : null,
      })),
      recentlySuspended: suspended.rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        disabledAt: new Date(r.disabled_at),
      })),
      orgsAtOrOverLimit: atLimit.rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        planTier: r.plan_tier,
        seatLimit: r.seat_limit,
        seatsUsed: r.used,
      })),
    };
  },
};
