import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { PLATFORM_AUDIT_ACTIONS, PlatformAuditService } from "@/domain/platform-admin/platform-audit-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pager, Table, first, formatDate, pageParam } from "../_components";

function parseDay(value: string | undefined, endOfDay = false): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  if (endOfDay) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const admin = await requirePlatformAdmin();
  const action = first(searchParams.action) ?? "";
  const targetOrganization = first(searchParams.org)?.trim() ?? "";
  const from = first(searchParams.from) ?? "";
  const to = first(searchParams.to) ?? "";
  const page = pageParam(first(searchParams.page));

  const { rows, total, pageSize } = await PlatformAuditService.list(admin.userId, {
    action: action || undefined,
    targetOrganization: targetOrganization || undefined,
    from: parseDay(from),
    to: parseDay(to, true),
    page,
  });

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Admin audit log</h1>
        <p className="text-sm text-muted-foreground">
          Append-only record of every platform admin action. Cannot be edited or deleted by the application.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <select
          name="action"
          defaultValue={action}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          aria-label="Action"
        >
          <option value="">All actions</option>
          {PLATFORM_AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <Input name="org" defaultValue={targetOrganization} placeholder="Organization id" className="w-72" />
        <Input name="from" type="date" defaultValue={from} className="w-40" aria-label="From date" />
        <Input name="to" type="date" defaultValue={to} className="w-40" aria-label="To date" />
        <Button type="submit" size="sm">
          Filter
        </Button>
      </form>

      <Table head={["When", "Admin", "Action", "Target", "Before → After"]} empty="No admin actions recorded.">
        {rows.map((r) => (
          <tr key={r.id} className="align-top">
            <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatDate(r.createdAt)}</td>
            <td className="px-3 py-2">{r.adminEmail}</td>
            <td className="px-3 py-2">{r.action}</td>
            <td className="px-3 py-2 text-xs">
              {r.targetType}
              {r.targetOrganization ? (
                <>
                  {" · "}
                  <Link href={`/admin/organizations/${r.targetOrganization}`} className="hover:underline">
                    org
                  </Link>
                </>
              ) : r.targetType === "User" ? (
                <>
                  {" · "}
                  <Link href={`/admin/users/${r.targetId}`} className="hover:underline">
                    user
                  </Link>
                </>
              ) : null}
            </td>
            <td className="px-3 py-2 font-mono text-xs">
              {r.before !== null || r.after !== null ? `${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}` : "—"}
            </td>
          </tr>
        ))}
      </Table>
      <Pager basePath="/admin/audit" params={{ action, org: targetOrganization, from, to }} page={page} pageSize={pageSize} total={total} />
    </>
  );
}
