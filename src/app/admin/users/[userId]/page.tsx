import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { DirectoryService } from "@/domain/platform-admin/directory-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice, Table, first, formatDate } from "../../_components";
import { reactivateUserAction, suspendUserAction } from "../../actions";

export default async function AdminUserPage({
  params,
  searchParams,
}: {
  params: { userId: string };
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const admin = await requirePlatformAdmin();
  const user = await DirectoryService.getUser(admin.userId, params.userId);
  if (!user) notFound();
  const isSelf = user.id === admin.userId;
  const returnTo = `/admin/users/${user.id}`;

  return (
    <>
      <div>
        <p className="text-xs text-muted-foreground">
          <Link href="/admin/users" className="hover:underline">
            Users
          </Link>
        </p>
        <h1 className="text-xl font-semibold">{user.email}</h1>
        <p className="text-sm text-muted-foreground">
          {user.name} · created {formatDate(user.createdAt)} ·{" "}
          {user.disabledAt ? (
            <span className="text-destructive">suspended {formatDate(user.disabledAt)}</span>
          ) : (
            "active"
          )}
        </p>
      </div>

      <Notice ok={first(searchParams.ok)} error={first(searchParams.error)} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account access</CardTitle>
          <CardDescription>
            A suspended user cannot sign in, and any session they already have stops working on their next request.
            Their memberships and data are untouched; reactivating restores access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isSelf ? (
            <p className="text-sm text-muted-foreground">You cannot suspend your own account.</p>
          ) : user.disabledAt ? (
            <form action={reactivateUserAction}>
              <input type="hidden" name="userId" value={user.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <Button type="submit">Reactivate user</Button>
            </form>
          ) : (
            <form action={suspendUserAction}>
              <input type="hidden" name="userId" value={user.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <Button type="submit" variant="destructive">
                Suspend user
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Organizations</h2>
        <Table head={["Organization", "Role", "Joined", "Status"]} empty="Not a member of any organization.">
          {user.memberships.map((m) => (
            <tr key={m.membershipId} className={m.isActive ? "" : "text-muted-foreground"}>
              <td className="px-3 py-2">
                <Link href={`/admin/organizations/${m.organizationId}`} className="font-medium hover:underline">
                  {m.organizationName}
                </Link>{" "}
                <span className="text-xs text-muted-foreground">/{m.organizationSlug}</span>
              </td>
              <td className="px-3 py-2">{m.role}</td>
              <td className="px-3 py-2">{formatDate(m.joinedAt)}</td>
              <td className="px-3 py-2">{m.isActive ? "Active" : "Removed"}</td>
            </tr>
          ))}
        </Table>
      </section>
    </>
  );
}
