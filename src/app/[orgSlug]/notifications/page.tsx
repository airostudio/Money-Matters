import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { NotificationService, type NotificationView } from "@/domain/notifications/notification-service";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { clearOldAction, dismissAction, markAllReadAction, markReadAction } from "./actions";

const SEVERITY_STYLES: Record<NotificationView["severity"], string> = {
  INFO: "bg-muted text-muted-foreground",
  ACTION: "bg-primary/10 text-primary",
  WARNING: "bg-warning/20",
  CRITICAL: "bg-destructive/10 text-destructive",
};
const SEVERITY_LABELS: Record<NotificationView["severity"], string> = { INFO: "Info", ACTION: "Needs action", WARNING: "Warning", CRITICAL: "Critical" };

function formatTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

interface Group {
  key: string;
  title: string;
  severity: NotificationView["severity"];
  items: NotificationView[];
  unread: number;
}

/** Groups a rule's notifications together (s.66: no spam), newest group first. A rule with one item stays a plain row. */
function group(items: NotificationView[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const key = item.sourceRefId ? `${item.source}:${item.sourceRefId}` : item.id;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      if (!item.readAt) existing.unread += 1;
    } else groups.set(key, { key, title: item.title, severity: item.severity, items: [item], unread: item.readAt ? 0 : 1 });
  }
  return [...groups.values()];
}

function Row({ item, markRead, dismiss }: { item: NotificationView; markRead: (formData: FormData) => Promise<void>; dismiss: (formData: FormData) => Promise<void> }) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-3 px-6 py-3 text-sm ${item.readAt ? "" : "bg-primary/5"}`} data-testid="notification-item">
      <div className="min-w-0 space-y-0.5">
        <p>
          <span className={`mr-2 rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_STYLES[item.severity]}`}>{SEVERITY_LABELS[item.severity]}</span>
          <span className={item.readAt ? "" : "font-medium"}>{item.title}</span>
          {item.occurrences > 1 && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">x{item.occurrences}</span>}
        </p>
        {item.body && <p className="text-muted-foreground">{item.body}</p>}
        <p className="text-xs text-muted-foreground">
          {formatTime(item.lastOccurredAt)}
          {item.link && (
            <>
              {" - "}
              <Link href={item.link} className="text-primary underline">
                Open
              </Link>
            </>
          )}
        </p>
      </div>
      <div className="flex gap-2">
        {!item.readAt && (
          <form action={markRead}>
            <input type="hidden" name="notificationId" value={item.id} />
            <Button type="submit" size="sm" variant="secondary">
              Mark read
            </Button>
          </form>
        )}
        <form action={dismiss}>
          <input type="hidden" name="notificationId" value={item.id} />
          <Button type="submit" size="sm" variant="ghost">
            Dismiss
          </Button>
        </form>
      </div>
    </div>
  );
}

/**
 * Notifications (master spec s.66, minimal slice): a person's own list. The unread count is computed HERE (one cheap
 * aggregate, sequential after the list) and on the home page - never in the shared layout, which is the hot path.
 */
export default async function NotificationsPage({ params, searchParams }: { params: { orgSlug: string }; searchParams: { cleared?: string } }) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);
  const items = await NotificationService.list(actor, { limit: 200 });
  const unread = await NotificationService.unreadCount(actor);
  const groups = group(items);
  const boundRead = markReadAction.bind(null, org.slug);
  const boundDismiss = dismissAction.bind(null, org.slug);
  const boundReadAll = markAllReadAction.bind(null, org.slug);
  const boundClear = clearOldAction.bind(null, org.slug);
  const cleared = searchParams.cleared && /^\d{1,4}$/.test(searchParams.cleared) ? Number(searchParams.cleared) : null;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="text-sm text-muted-foreground" data-testid="unread-count">
            {unread === 0 ? "You are all caught up." : `${unread} unread.`} Only you can see this list.
          </p>
        </div>
        <div className="flex gap-2">
          {unread > 0 && (
            <form action={boundReadAll}>
              <Button type="submit" size="sm" variant="secondary">
                Mark all read
              </Button>
            </form>
          )}
          <form action={boundClear}>
            <Button type="submit" size="sm" variant="ghost" title="Removes your dismissed notifications and anything older than 30 days">
              Clear old
            </Button>
          </form>
        </div>
      </div>
      {cleared !== null && <p role="status" className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">Removed {cleared} old notification(s).</p>}

      <Card>
        <CardContent className="p-0">
          {groups.length === 0 ? (
            <p className="px-6 py-6 text-sm text-muted-foreground" data-testid="notifications-empty">
              Nothing here. Notifications from your automation rules will appear on this page.
            </p>
          ) : (
            <div className="divide-y divide-border" data-testid="notification-list">
              {groups.map((g) =>
                g.items.length === 1 ? (
                  <Row key={g.key} item={g.items[0]!} markRead={boundRead} dismiss={boundDismiss} />
                ) : (
                  <details key={g.key} className="group" open={g.unread > 0 && g.items.length <= 3} data-testid="notification-group">
                    <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm">
                      <span>
                        <span className={`mr-2 rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_STYLES[g.severity]}`}>{SEVERITY_LABELS[g.severity]}</span>
                        <span className="font-medium">{g.title}</span> <span className="text-muted-foreground">- {g.items.length} items{g.unread > 0 ? `, ${g.unread} unread` : ""}</span>
                      </span>
                    </summary>
                    <div className="divide-y divide-border border-t border-border">
                      {g.items.map((item) => (
                        <Row key={item.id} item={item} markRead={boundRead} dismiss={boundDismiss} />
                      ))}
                    </div>
                  </details>
                ),
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
