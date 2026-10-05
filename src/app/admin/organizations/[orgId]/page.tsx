import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { DirectoryService } from "@/domain/platform-admin/directory-service";
import { PlatformAuditService } from "@/domain/platform-admin/platform-audit-service";
import { MAX_SEAT_LIMIT } from "@/domain/platform-admin/platform-admin-service";
import { membershipRoleEnum, planTierEnum } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice, Stat, Table, first, formatDate } from "../../_components";
import { changeMemberRoleAction, removeMemberAction, updateOrganizationPlanAction } from "../../actions";

export default async function AdminOrganizationPage({
  params,
  searchParams,
}: {
  params: { orgId: string };
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const admin = await requirePlatformAdmin();
  const org = await DirectoryService.getOrganization(admin.userId, params.orgId);
  if (!org) notFound();
  const recent = await PlatformAuditService.listForOrganization(admin.userId, org.id);
  const returnTo = `/admin/organizations/${org.id}`;
  const activeMembers = org.members.filter((m) => m.isActive);
  const selectClass = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  return (
    <>
      <div>
        <p className="text-xs text-muted-foreground">
          <Link href="/admin/organizations" className="hover:underline">
            Organizations
          </Link>{" "}
          / {org.slug}
        </p>
        <h1 className="text-xl font-semibold">{org.name}</h1>
        <p className="text-sm text-muted-foreground">Created {formatDate(org.createdAt)}</p>
      </div>

      <Notice ok={first(searchParams.ok)} error={first(searchParams.error)} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Seats" value={`${org.seatsUsed} of ${org.seatLimit}`} hint={org.seatsUsed > org.seatLimit ? "Over limit" : org.seatsUsed >= org.seatLimit ? "At limit" : "Seat available"} />
        <Stat label="Plan tier" value={org.planTier} />
        <Stat label="Active members" value={activeMembers.length} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Seat limit and plan</CardTitle>
          <CardDescription>
            Takes effect immediately. The plan tier is a label only — there is no billing yet. Lowering the limit
            below current usage is refused.
          </CardDescription>
        </CardHeader>
        <form action={updateOrganizationPlanAction}>
          <input type="hidden" name="organizationId" value={org.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="seatLimit">Seat limit</Label>
              <Input id="seatLimit" name="seatLimit" type="number" min={1} max={MAX_SEAT_LIMIT} defaultValue={org.seatLimit} className="w-32" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="planTier">Plan tier</Label>
              <select id="planTier" name="planTier" defaultValue={org.planTier} className={selectClass}>
                {planTierEnum.enumValues.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit">Save</Button>
          </CardContent>
        </form>
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Members</h2>
        <Table head={["Member", "Role", "Joined", "Status", ""]} empty="No members.">
          {org.members.map((m) => (
            <tr key={m.membershipId} className={m.isActive ? "" : "text-muted-foreground"}>
              <td className="px-3 py-2">
                <Link href={`/admin/users/${m.userId}`} className="font-medium hover:underline">
                  {m.email}
                </Link>
                <div className="text-xs text-muted-foreground">{m.name}</div>
              </td>
              <td className="px-3 py-2">
                {m.isActive ? (
                  <form action={changeMemberRoleAction} className="flex items-center gap-2">
                    <input type="hidden" name="organizationId" value={org.id} />
                    <input type="hidden" name="membershipId" value={m.membershipId} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <select name="role" defaultValue={m.role} className={selectClass} aria-label={`Role for ${m.email}`}>
                      {membershipRoleEnum.enumValues.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" size="sm" variant="outline">
                      Change
                    </Button>
                  </form>
                ) : (
                  m.role
                )}
              </td>
              <td className="px-3 py-2">{formatDate(m.joinedAt)}</td>
              <td className="px-3 py-2">{!m.isActive ? "Removed" : m.suspended ? "User suspended" : "Active"}</td>
              <td className="px-3 py-2">
                {m.isActive && (
                  <form action={removeMemberAction}>
                    <input type="hidden" name="organizationId" value={org.id} />
                    <input type="hidden" name="membershipId" value={m.membershipId} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <Button type="submit" size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                      Remove
                    </Button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </Table>
        <p className="text-xs text-muted-foreground">
          The last OWNER cannot be demoted or removed. Role and membership changes are recorded in both the platform
          audit log and this organization&apos;s own audit log.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Recent admin actions on this organization</h2>
        <Table head={["When", "Action", "Admin", "Change"]} empty="No admin actions yet.">
          {recent.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatDate(r.createdAt)}</td>
              <td className="px-3 py-2">{r.action}</td>
              <td className="px-3 py-2">{r.adminEmail}</td>
              <td className="px-3 py-2 font-mono text-xs">
                {JSON.stringify(r.before)} → {JSON.stringify(r.after)}
              </td>
            </tr>
          ))}
        </Table>
      </section>
    </>
  );
}
