import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { platformAdminAuditLogs } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import { redactSensitive } from "@/domain/audit/audit-service";
import { verifyPlatformAdmin, type PlatformAdmin } from "./identity";

export const PLATFORM_AUDIT_ACTIONS = [
  "organization.plan_changed",
  "membership.role_changed",
  "membership.removed",
  "user.suspended",
  "user.reactivated",
  "directory.exported",
] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export interface RecordPlatformAuditParams {
  action: PlatformAuditAction;
  targetType: "Organization" | "OrganizationMembership" | "User" | "Directory";
  targetId: string;
  targetOrganization?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export interface PlatformAuditFilters {
  action?: string;
  targetType?: string;
  targetOrganization?: string;
  from?: Date;
  /** Exclusive upper bound. */
  to?: Date;
  page?: number;
  pageSize?: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The platform-level, append-only audit trail (platform_admin_audit_logs).
 * mm_app can only INSERT and SELECT — there is no update or delete here by
 * design, and the database would refuse one. `record` returns the new row's
 * id so the affected organization's own audit entry can link to it.
 */
export const PlatformAuditService = {
  async record(tx: Pick<TenantDb, "insert">, admin: PlatformAdmin, params: RecordPlatformAuditParams): Promise<string> {
    const id = randomUUID();
    await tx.insert(platformAdminAuditLogs).values({
      id,
      adminUserId: admin.userId,
      adminEmail: admin.email,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      targetOrganization: params.targetOrganization ?? null,
      before: params.before !== undefined ? (redactSensitive(params.before) as object) : null,
      after: params.after !== undefined ? (redactSensitive(params.after) as object) : null,
      metadata: params.metadata ?? null,
    });
    return id;
  },

  async list(adminUserId: string, filters: PlatformAuditFilters = {}) {
    await verifyPlatformAdmin(adminUserId);
    const pageSize = Math.min(Math.max(filters.pageSize ?? 25, 1), 100);
    const page = Math.max(filters.page ?? 1, 1);

    const conditions: SQL[] = [];
    if (filters.action) conditions.push(eq(platformAdminAuditLogs.action, filters.action));
    if (filters.targetType) conditions.push(eq(platformAdminAuditLogs.targetType, filters.targetType));
    if (filters.targetOrganization && UUID_PATTERN.test(filters.targetOrganization)) {
      conditions.push(eq(platformAdminAuditLogs.targetOrganization, filters.targetOrganization));
    }
    if (filters.from) conditions.push(gte(platformAdminAuditLogs.createdAt, filters.from));
    if (filters.to) conditions.push(lt(platformAdminAuditLogs.createdAt, filters.to));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(platformAdminAuditLogs)
      .where(where)
      .orderBy(desc(platformAdminAuditLogs.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(platformAdminAuditLogs)
      .where(where);

    return { rows, total: count?.n ?? 0, page, pageSize };
  },

  async listForOrganization(adminUserId: string, organizationId: string, limit = 20) {
    await verifyPlatformAdmin(adminUserId);
    if (!UUID_PATTERN.test(organizationId)) return [];
    return db
      .select()
      .from(platformAdminAuditLogs)
      .where(eq(platformAdminAuditLogs.targetOrganization, organizationId))
      .orderBy(desc(platformAdminAuditLogs.createdAt))
      .limit(limit);
  },
};
