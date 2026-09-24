import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  POSTED: "bg-success/10 text-success",
  REVERSED: "bg-warning/10 text-warning",
  OPEN: "bg-success/10 text-success",
  SOFT_LOCKED: "bg-warning/10 text-warning",
  HARD_LOCKED: "bg-destructive/10 text-destructive",
  APPROVED: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  SENT: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  VIEWED: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  PART_PAID: "bg-warning/10 text-warning",
  PAID: "bg-success/10 text-success",
  VOID: "bg-destructive/10 text-destructive",
  OVERDUE: "bg-destructive/10 text-destructive",
  SUBMITTED: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  REJECTED: "bg-destructive/10 text-destructive",
  REIMBURSED: "bg-success/10 text-success",
  EXTRACTED: "bg-success/10 text-success",
  FAILED: "bg-destructive/10 text-destructive",
  NOT_ATTEMPTED: "bg-muted text-muted-foreground",
  ACCEPTED: "bg-success/10 text-success",
  DECLINED: "bg-destructive/10 text-destructive",
  CONVERTED: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  EXPIRED: "bg-destructive/10 text-destructive",
  PARTIALLY_RECEIVED: "bg-warning/10 text-warning",
  RECEIVED: "bg-success/10 text-success",
  CLOSED: "bg-muted text-muted-foreground",
  CANCELLED: "bg-destructive/10 text-destructive",
  PART_APPLIED: "bg-warning/10 text-warning",
  APPLIED: "bg-success/10 text-success",
  AWAITING_APPROVAL: "bg-warning/10 text-warning",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
        STATUS_STYLES[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {status.toLowerCase().replace(/_/g, " ")}
    </span>
  );
}
