import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { DirectoryService, type SeatFilter } from "@/domain/platform-admin/directory-service";
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
  const page = pageParam(first(searchParams.page));
  const { rows, total, pageSize } = await DirectoryService.listOrganizations(admin.userId, { q, seats, page });
  const exportParams = new URLSearchParams();
  if (q) exportParams.set("q", q);
  if (seats !== "all") exportParams.set("seats", seats);

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
      <Pager basePath="/admin/organizations" params={{ q, seats: seats === "all" ? undefined : seats }} page={page} pageSize={pageSize} total={total} />
    </>
  );
}
