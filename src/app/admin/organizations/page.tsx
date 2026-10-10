import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { DirectoryService, type SeatFilter, type StatusFilter } from "@/domain/platform-admin/directory-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pager, Table, first, formatDate, pageParam } from "../_components";

export default async function AdminOrganizationsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const admin = await requirePlatformAdmin();
  const q = first(searchParams.q)?.slice(0, 100) ?? "";
  const seats: SeatFilter = first(searchParams.seats) === "full" ? "full" : first(searchParams.seats) === "over" ? "over" : "all";
  const statusParam = first(searchParams.status);
  const status: StatusFilter = statusParam === "archived" ? "archived" : statusParam === "active" ? "active" : "all";
  const page = pageParam(first(searchParams.page));
  const { rows, total, pageSize } = await DirectoryService.listOrganizations(admin.userId, { q, seats, status, page });
  const exportParams = new URLSearchParams();
  if (q) exportParams.set("q", q);
  if (seats !== "all") exportParams.set("seats", seats);
  if (status !== "all") exportParams.set("status", status);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">Organizations</h1>
        <Link
          href={`/admin/export/organizations?${exportParams.toString()}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Export CSV (directory data only)
        </Link>
      </div>

      <form className="flex flex-wrap items-center gap-2" method="get">
        <Input name="q" defaultValue={q} placeholder="Search name or slug" className="max-w-xs" />
        <select
          name="seats"
          defaultValue={seats}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          aria-label="Seat filter"
        >
          <option value="all">All seat states</option>
          <option value="full">At seat limit</option>
          <option value="over">Over seat limit</option>
        </select>
        <select
          name="status"
          defaultValue={status}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          aria-label="Status filter"
        >
          <option value="all">Active and archived</option>
          <option value="active">Active only</option>
          <option value="archived">Archived only</option>
        </select>
        <Button type="submit" size="sm">
          Search
        </Button>
      </form>

      <Table head={["Organization", "Plan", "Seats", "Members", "Created"]} empty="No organizations match.">
        {rows.map((o) => (
          <tr key={o.id}>
            <td className="px-3 py-2">
              <Link href={`/admin/organizations/${o.id}`} className="font-medium hover:underline">
                {o.name}
              </Link>{" "}
              <span className="text-xs text-muted-foreground">/{o.slug}</span>
              {o.archivedAt && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">Archived</span>}
            </td>
            <td className="px-3 py-2">{o.planTier}</td>
            <td className="px-3 py-2 tabular-nums">
              {o.seatsUsed} of {o.seatLimit}
            </td>
            <td className="px-3 py-2 tabular-nums">{o.memberCount}</td>
            <td className="px-3 py-2 text-muted-foreground">{formatDate(o.createdAt)}</td>
          </tr>
        ))}
      </Table>
      <Pager basePath="/admin/organizations" params={{ q, seats: seats === "all" ? undefined : seats, status: status === "all" ? undefined : status }} page={page} pageSize={pageSize} total={total} />
    </>
  );
}
