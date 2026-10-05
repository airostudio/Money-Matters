import { cn } from "@/lib/utils";

const STYLES = {
  GREEN: { dot: "bg-success", text: "text-success", name: "Good" },
  AMBER: { dot: "bg-warning", text: "text-warning", name: "Needs attention" },
  RED: { dot: "bg-destructive", text: "text-destructive", name: "Urgent" },
  GREY: { dot: "bg-muted-foreground/40", text: "text-muted-foreground", name: "No data" },
} as const;

/**
 * A traffic-light indicator: a coloured dot AND the plain-language label beside it, with the
 * status also spelled out for assistive technology — never colour alone.
 */
export function LightBadge({ light, label, className }: { light: keyof typeof STYLES; label: string; className?: string }) {
  const s = STYLES[light];
  return (
    <span className={cn("inline-flex items-start gap-1.5 text-xs", className)}>
      <span aria-hidden className={cn("mt-1 size-2 shrink-0 rounded-full", s.dot)} />
      <span className="sr-only">{s.name}: </span>
      <span className={cn(light === "GREY" ? "text-muted-foreground" : "text-foreground")}>{label}</span>
    </span>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "error"; children: React.ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "warning" && "border-warning/40 bg-warning/10 text-foreground",
        tone === "info" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}
