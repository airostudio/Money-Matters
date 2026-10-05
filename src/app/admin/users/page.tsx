import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { DirectoryService } from "@/domain/platform-admin/directory-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pager, Table, first, formatDate, pageParam } from "../_components";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const admin = await requirePlatformAdmin();
  const q = first(searchParams.q)?.slice(0, 100) ?? "";
  const page = pageParam(first(searchParams.page));
  const { rows, total, pageSize } = await DirectoryService.listUsers(admin.userId, { q, page });
  const exportParams = new URLSearchParams();
  if (q) exportParams.set("q", q);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">Users</h1>
        <Link
          href={`/admin/export/users?${exportParams.toString()}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Export CSV (directory data only)
        </Link>
      </div>

      <form className="flex flex-wrap items-center gap-2" method="get">
        <Input name="q" defaultValue={q} placeholder="Search email or name" className="max-w-xs" />
        <Button type="submit" size="sm">
          Search
        </Button>
      </form>

      <Table head={["User", "Status", "Organizations", "Created"]} empty="No users match.">
        {rows.map((u) => (
          <tr key={u.id}>
            <td className="px-3 py-2">
              <Link href={`/admin/users/${u.id}`} className="font-medium hover:underline">
                {u.email}
              </Link>
              <div className="text-xs text-muted-foreground">{u.name}</div>
            </td>
            <td className="px-3 py-2">
              {u.disabledAt ? <span className="text-destructive">Suspended</span> : "Active"}
            </td>
            <td className="px-3 py-2 text-xs">
              {u.organizations.length === 0
                ? "—"
                : u.organizations.map((o) => `${o.name} (${o.role})`).join(", ")}
            </td>
            <td className="px-3 py-2 text-muted-foreground">{formatDate(u.createdAt)}</td>
          </tr>
        ))}
      </Table>
      <Pager basePath="/admin/users" params={{ q }} page={page} pageSize={pageSize} total={total} />
    </>
  );
}
