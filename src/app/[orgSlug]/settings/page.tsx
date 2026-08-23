import { requireOrgAndActor } from "@/lib/session";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { membershipRoleEnum } from "@/db/schema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { inviteMemberAction, removeMemberAction, updateMemberRoleAction } from "./actions";
import { MemberRoleSelect } from "@/components/shell/member-role-select";

export default async function SettingsPage({ params }: { params: { orgSlug: string } }) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);
  const canManageMembers = roleHasPermission(actor.role, "membership:manage");

  const members = canManageMembers ? await OrganizationService.listMembers(actor) : [];

  const boundInvite = inviteMemberAction.bind(null, org.slug);
  const boundUpdateRole = updateMemberRoleAction.bind(null, org.slug);
  const boundRemove = removeMemberAction.bind(null, org.slug);

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Organization details and team access.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organization</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Name</p>
            <p className="font-medium">{org.name}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Base currency</p>
            <p className="font-medium">{org.baseCurrency}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Country</p>
            <p className="font-medium">{org.country}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Your role</p>
            <p className="font-medium">{actor.role}</p>
          </div>
        </CardContent>
      </Card>

      {canManageMembers && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Team</CardTitle>
              <CardDescription>Everyone with access to {org.name}.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {members.map((member) => (
                  <div key={member.membershipId} className="flex items-center justify-between gap-4 px-6 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{member.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <MemberRoleSelect
                        membershipId={member.membershipId}
                        currentRole={member.role}
                        disabled={member.userId === actor.userId}
                        action={boundUpdateRole}
                      />
                      <form action={boundRemove}>
                        <input type="hidden" name="membershipId" value={member.membershipId} />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={member.userId === actor.userId}
                        >
                          Remove
                        </Button>
                      </form>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Invite a teammate</CardTitle>
              <CardDescription>They must already have a Money Matters account.</CardDescription>
            </CardHeader>
            <form action={boundInvite}>
              <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" name="email" type="email" placeholder="teammate@example.com" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="role">Role</Label>
                  <select
                    id="role"
                    name="role"
                    defaultValue="BOOKKEEPER"
                    className="flex h-9 w-40 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {membershipRoleEnum.enumValues.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="submit">Invite</Button>
              </CardContent>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}
