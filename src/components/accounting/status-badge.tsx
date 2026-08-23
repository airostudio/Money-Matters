import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  POSTED: "bg-success/10 text-success",
  REVERSED: "bg-warning/10 text-warning",
  OPEN: "bg-success/10 text-success",
  SOFT_LOCKED: "bg-warning/10 text-warning",
  HARD_LOCKED: "bg-destructive/10 text-destructive",
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
