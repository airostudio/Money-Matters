import Link from "next/link";

/** Small presentational helpers shared by the admin pages (server components). */

export function Notice({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <p
      role={error ? "alert" : "status"}
      className={`rounded-md px-3 py-2 text-sm ${error ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"}`}
    >
      {(error ?? ok ?? "").slice(0, 600)}
    </p>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Table({ head, children, empty }: { head: string[]; children: React.ReactNode; empty?: string }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border bg-muted/50 text-xs text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {hasRows ? (
            children
          ) : (
            <tr>
              <td colSpan={head.length} className="px-3 py-6 text-center text-muted-foreground">
                {empty ?? "Nothing to show."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({
  basePath,
  params,
  page,
  pageSize,
  total,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  page: number;
  pageSize: number;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    qs.set("page", String(p));
    return `${basePath}?${qs.toString()}`;
  };
  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span>
        {total} result{total === 1 ? "" : "s"} · page {Math.min(page, pages)} of {pages}
      </span>
      <span className="flex gap-4">
        {page > 1 && (
          <Link href={href(page - 1)} className="hover:text-foreground">
            Previous
          </Link>
        )}
        {page < pages && (
          <Link href={href(page + 1)} className="hover:text-foreground">
            Next
          </Link>
        )}
      </span>
    </div>
  );
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function pageParam(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
