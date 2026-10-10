import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { notifications } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * In-app notifications (master spec s.66, minimal slice) - the safe target of the `NOTIFY_IN_APP` automation action.
 *
 *  - ONE row per recipient. Roles are resolved to concrete users when the notification is created, so a person who gains
 *    a role later does not suddenly see old items and nobody is shown another person's inbox.
 *  - A person sees ONLY their own notifications: every read and every change below filters on `recipient_user_id =
 *    actor.userId` as well as the organization (RLS isolates organizations; this service rule isolates people), and only a
 *    HUMAN actor may use it - an API key, AI agent or automation can create notifications (through the engine) but never read or change anyone's inbox.
 *  - Repeated identical items fold into one (`occurrences`) instead of piling up (s.66: avoid alert spam).
 *  - DB discipline: no method here opens more than one transaction; `createIn` runs inside the CALLER's transaction.
 *  - Reading, dismissing and clearing one's own inbox is not a change to the books and is not written to the audit log
 *    (it would only bury it); the creation of every notification is covered by the automation run log and its audit row,
 *    and the bulk purge IS audited.
 */
export const NOTIFICATION_RETENTION_DAYS = 30;
/** Identical unread items fold only within this window. */
export const FOLD_WINDOW_MS = 24 * 3_600_000;
export const MAX_LIST = 200;
export const MAX_NOTIFICATION_TITLE = 120;
export const MAX_NOTIFICATION_BODY = 500;

export class NotificationAccessError extends Error {
  constructor() {
    super("Notifications can only be read by the person they belong to.");
    this.name = "NotificationAccessError";
  }
}

function assertPerson(actor: Actor): void {
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new NotificationAccessError();
}

export interface NewNotification {
  title: string;
  body: string | null;
  link: string | null;
  severity: "INFO" | "ACTION" | "WARNING" | "CRITICAL";
  source: "automation" | "system";
  sourceRefId: string | null;
}

export function groupKeyOf(n: Pick<NewNotification, "source" | "sourceRefId" | "title" | "body" | "severity">): string {
  return createHash("sha256").update(`${n.source}\u0000${n.sourceRefId ?? ""}\u0000${n.severity}\u0000${n.title}\u0000${n.body ?? ""}`).digest("hex").slice(0, 32);
}

const clip = (text: string | null, max: number): string | null => (text === null ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A notification link must be an in-app path. Anything else is dropped rather than stored. */
export function safeInAppLink(link: string | null): string | null {
  if (!link) return null;
  return /^\/[A-Za-z0-9][A-Za-z0-9/_\-.]*$/.test(link) && !link.includes("..") && !link.startsWith("//") ? link : null;
}

export interface NotificationView {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: "INFO" | "ACTION" | "WARNING" | "CRITICAL";
  source: string;
  sourceRefId: string | null;
  occurrences: number;
  createdAt: Date;
  lastOccurredAt: Date;
  readAt: Date | null;
}

export const NotificationService = {
  /**
   * Creates (or folds into) one notification per recipient, inside the CALLER's transaction. Three statements at most,
   * however many recipients. Returns the number of recipients notified.
   */
  async createIn(tx: TenantDb, organizationId: string, recipientUserIds: readonly string[], notification: NewNotification, now: Date = new Date()): Promise<number> {
    const recipients = [...new Set(recipientUserIds)];
    if (recipients.length === 0) return 0;
    const title = clip(notification.title, MAX_NOTIFICATION_TITLE) ?? "Notification";
    const body = clip(notification.body, MAX_NOTIFICATION_BODY);
    const link = safeInAppLink(notification.link);
    const groupKey = groupKeyOf({ ...notification, title, body });

    const existing = await tx
      .select({ id: notifications.id, recipientUserId: notifications.recipientUserId })
      .from(notifications)
      .where(
        and(
          eq(notifications.organizationId, organizationId),
          inArray(notifications.recipientUserId, recipients),
          eq(notifications.groupKey, groupKey),
          isNull(notifications.readAt),
          isNull(notifications.dismissedAt),
          sql`${notifications.lastOccurredAt} > ${new Date(now.getTime() - FOLD_WINDOW_MS)}`,
        ),
      );
    const folded = new Set(existing.map((e) => e.recipientUserId));
    if (existing.length > 0) {
      await tx
        .update(notifications)
        .set({ occurrences: sql`${notifications.occurrences} + 1`, lastOccurredAt: now })
        .where(and(eq(notifications.organizationId, organizationId), inArray(notifications.id, existing.map((e) => e.id))));
    }
    const fresh = recipients.filter((r) => !folded.has(r));
    if (fresh.length > 0) {
      await tx.insert(notifications).values(
        fresh.map((recipientUserId) => ({
          organizationId,
          recipientUserId,
          title,
          body,
          link,
          severity: notification.severity,
          source: notification.source,
          sourceRefId: notification.sourceRefId,
          groupKey,
          createdAt: now,
          lastOccurredAt: now,
        })),
      );
    }
    return recipients.length;
  },

  /** The caller's own undismissed notifications, newest first. */
  async list(actor: Actor, options: { limit?: number } = {}): Promise<NotificationView[]> {
    assertPerson(actor);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_LIST);
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select({
          id: notifications.id,
          title: notifications.title,
          body: notifications.body,
          link: notifications.link,
          severity: notifications.severity,
          source: notifications.source,
          sourceRefId: notifications.sourceRefId,
          occurrences: notifications.occurrences,
          createdAt: notifications.createdAt,
          lastOccurredAt: notifications.lastOccurredAt,
          readAt: notifications.readAt,
        })
        .from(notifications)
        .where(and(eq(notifications.organizationId, actor.organizationId), eq(notifications.recipientUserId, actor.userId), isNull(notifications.dismissedAt)))
        .orderBy(desc(notifications.lastOccurredAt), desc(notifications.id))
        .limit(limit),
    );
  },

  /** ONE cheap aggregate. Called only by the notifications page and the home card - never by the shared layout. */
  async unreadCount(actor: Actor): Promise<number> {
    assertPerson(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.organizationId, actor.organizationId), eq(notifications.recipientUserId, actor.userId), isNull(notifications.readAt), isNull(notifications.dismissedAt)));
      return row?.n ?? 0;
    });
  },

  async markRead(actor: Actor, notificationId: string): Promise<boolean> {
    assertPerson(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.id, notificationId), eq(notifications.organizationId, actor.organizationId), eq(notifications.recipientUserId, actor.userId), isNull(notifications.readAt)))
        .returning({ id: notifications.id });
      return rows.length > 0;
    });
  },

  async markAllRead(actor: Actor): Promise<number> {
    assertPerson(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.organizationId, actor.organizationId), eq(notifications.recipientUserId, actor.userId), isNull(notifications.readAt), isNull(notifications.dismissedAt)))
        .returning({ id: notifications.id });
      return rows.length;
    });
  },

  async dismiss(actor: Actor, notificationId: string): Promise<boolean> {
    assertPerson(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const now = new Date();
      const rows = await tx
        .update(notifications)
        .set({ dismissedAt: now, readAt: sql`coalesce(${notifications.readAt}, ${now})` })
        .where(and(eq(notifications.id, notificationId), eq(notifications.organizationId, actor.organizationId), eq(notifications.recipientUserId, actor.userId), isNull(notifications.dismissedAt)))
        .returning({ id: notifications.id });
      return rows.length > 0;
    });
  },

  /** Dismisses every notification in one group (a folded run of identical items from one rule). */
  async dismissAllRead(actor: Actor): Promise<number> {
    assertPerson(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .update(notifications)
        .set({ dismissedAt: new Date() })
        .where(and(eq(notifications.organizationId, actor.organizationId), eq(notifications.recipientUserId, actor.userId), isNotNull(notifications.readAt), isNull(notifications.dismissedAt)))
        .returning({ id: notifications.id });
      return rows.length;
    });
  },

  /**
   * Retention purge on demand: deletes the caller's OWN dismissed notifications and any of their notifications older than
   * the retention window. Audited (it removes records).
   */
  async purge(actor: Actor, options: { olderThanDays?: number } = {}, now: Date = new Date()): Promise<number> {
    assertPerson(actor);
    const days = Math.min(Math.max(Math.floor(options.olderThanDays ?? NOTIFICATION_RETENTION_DAYS), 1), 365);
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .delete(notifications)
        .where(
          and(
            eq(notifications.organizationId, actor.organizationId),
            eq(notifications.recipientUserId, actor.userId),
            or(isNotNull(notifications.dismissedAt), lt(notifications.createdAt, cutoff)),
          ),
        )
        .returning({ id: notifications.id });
      if (rows.length > 0) {
        await AuditService.record(tx, actor, { action: "notification.purged", entityType: "Notification", entityId: actor.userId, after: { removed: rows.length, olderThanDays: days } });
      }
      return rows.length;
    });
  },
};
