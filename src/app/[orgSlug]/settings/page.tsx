import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { DEFAULT_INVITE_ROLE, roleOptions } from "@/domain/permissions/role-info";
import { AUTONOMY_LEVELS, AUTONOMY_LEVEL_LABELS, AUTONOMY_LEVEL_DESCRIPTIONS } from "@/domain/ai-controller/autonomy";
import {
  AUTO_APPROVABLE_ACTION_TYPES,
  AUTO_APPROVED_ACTION_LABELS,
  AutoApprovedActionsService,
} from "@/domain/ai-controller/auto-execution-policy";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  emergencyStopAction,
  inviteMemberAction,
  removeMemberAction,
  runAutoExecutionsAction,
  updateAutoApprovedActionAction,
  updateAutonomyLevelAction,
  updateMemberRoleAction,
} from "./actions";
import { MemberRoleSelect } from "@/components/shell/member-role-select";
import { InviteMemberForm } from "@/components/shell/invite-member-form";

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { memberError?: string };
}) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);
  const canManageMembers = roleHasPermission(actor.role, "membership:manage");
  const canManageOrganization = roleHasPermission(actor.role, "organization:manage");
  const canManageApiKeys = roleHasPermission(actor.role, "api_key:manage");
  const canManageWebhooks = roleHasPermission(actor.role, "webhook:manage");

  const members = canManageMembers
    ? (await OrganizationService.listMembers(actor)).filter((m) => m.isActive)
    : [];
  const seats = canManageMembers ? await OrganizationService.getSeatUsage(org.id) : null;
  const memberError = typeof searchParams.memberError === "string" ? searchParams.memberError.slice(0, 600) : null;
  const autoApprovedActions = await AutoApprovedActionsService.list(org.id);
  const enabledActionTypes = new Set(autoApprovedActions.map((a) => a.actionType));
  const autonomyLevel = org.aiAutonomyLevel as 0 | 1 | 2 | 3 | 4;

  const roles = roleOptions();
  const boundInvite = inviteMemberAction.bind(null, org.slug);
  const boundUpdateRole = updateMemberRoleAction.bind(null, org.slug);
  const boundRemove = removeMemberAction.bind(null, org.slug);
  const boundUpdateAutonomy = updateAutonomyLevelAction.bind(null, org.slug);
  const boundEmergencyStop = emergencyStopAction.bind(null, org.slug);
  const boundUpdateAutoApproved = updateAutoApprovedActionAction.bind(null, org.slug);
  const boundRunAutoExecutions = runAutoExecutionsAction.bind(null, org.slug);

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

      {canManageOrganization && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Accountant access</CardTitle>
            <CardDescription>
              Approve or revoke an accounting practice that wants to work on {org.name}&apos;s books, and see what to do to give its staff access.{" "}
              <Link href={`/${org.slug}/settings/accountant`} className="text-primary underline">
                Manage accountant access
              </Link>
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {canManageApiKeys && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">API access</CardTitle>
            <CardDescription>
              Create API keys for approved server integrations. Keys can read your data and create draft invoices, bills, customers and suppliers - never post, approve or pay anything.{" "}
              <Link href={`/${org.slug}/settings/api`} className="text-primary underline">
                Manage API keys
              </Link>
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {canManageWebhooks && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Webhooks</CardTitle>
            <CardDescription>
              Send signed events (invoice created or paid, payment received, bill approved, customer added) to your own server as they happen, with a delivery log, retries and replay.{" "}
              <Link href={`/${org.slug}/settings/webhooks`} className="text-primary underline">
                Manage webhooks
              </Link>
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI Financial Controller autonomy</CardTitle>
          <CardDescription>
            A sliding scale from 0 (information only) to 4 (finance automation). Levels 3 and 4 let the AI
            auto-execute a narrow, specific list of actions WITHOUT a confirmation click first — but only the action
            types you explicitly turn on below. Selecting a higher level by itself does nothing. Supplier payments,
            bank account details, payroll, tax, unusual journal entries, and closing a period are never offered here,
            at any level — see docs/ai-agents.md §3b.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {canManageOrganization ? (
            <form action={boundUpdateAutonomy} className="flex flex-col gap-4">
              <input type="range" name="autonomyLevelSlider" min={0} max={4} step={1} defaultValue={autonomyLevel} disabled className="w-full accent-primary" />
              {AUTONOMY_LEVELS.map((level) => (
                <label key={level} className="flex items-start gap-3 text-sm">
                  <input
                    type="radio"
                    name="autonomyLevel"
                    value={level}
                    defaultChecked={org.aiAutonomyLevel === level}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">{AUTONOMY_LEVEL_LABELS[level]}</span>
                    <br />
                    <span className="text-muted-foreground">{AUTONOMY_LEVEL_DESCRIPTIONS[level]}</span>
                  </span>
                </label>
              ))}
              <div>
                <Button type="submit" size="sm">
                  Save level
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Current level: <span className="font-medium">{AUTONOMY_LEVEL_LABELS[autonomyLevel] ?? org.aiAutonomyLevel}</span>.
              Only an Owner or Administrator can change this.
            </p>
          )}

          {autonomyLevel >= 3 && (
            <div className="space-y-3 rounded-md border border-border p-4">
              <p className="text-sm font-medium">Whitelisted action types (required for anything to auto-execute)</p>
              <p className="text-xs text-muted-foreground">
                Turning on Level {autonomyLevel} above does nothing by itself. Each action type below must also be
                explicitly turned on here — unchecked by default, even at Level 4.
              </p>
              {AUTO_APPROVABLE_ACTION_TYPES.map((actionType) => {
                const isEnabled = enabledActionTypes.has(actionType);
                return (
                  <form key={actionType} action={boundUpdateAutoApproved} className="flex items-start gap-3 text-sm">
                    <input type="hidden" name="actionType" value={actionType} />
                    <input type="hidden" name="enabled" value={(!isEnabled).toString()} />
                    <button
                      type="submit"
                      disabled={!canManageOrganization}
                      aria-pressed={isEnabled}
                      className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-input disabled:opacity-50"
                    >
                      {isEnabled ? "✓" : ""}
                    </button>
                    <span>{AUTO_APPROVED_ACTION_LABELS[actionType]}</span>
                  </form>
                );
              })}
              {canManageOrganization && (
                <form action={boundRunAutoExecutions} className="pt-2">
                  <Button type="submit" size="sm" variant="secondary">
                    Run automated actions now
                  </Button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    No background job queue exists yet — whitelisted actions run when you click this, or the next
                    time anyone uses the AI Financial Controller chat.
                  </p>
                </form>
              )}
            </div>
          )}

          {canManageOrganization && (
            <form action={boundEmergencyStop} className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">Emergency stop</p>
              <p className="mb-2 text-xs text-muted-foreground">
                Immediately drops this organization to Level 0 (information only). Takes effect on the very next
                check — nothing further auto-executes, even if a whitelist entry is still saved. The whitelist itself
                is kept so you can re-enable the same configuration later.
              </p>
              <Button type="submit" size="sm" variant="destructive">
                Stop all AI automation now
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      {canManageMembers && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Team</CardTitle>
              <CardDescription>
                Everyone with access to {org.name}.
                {seats && (
                  <>
                    {" "}
                    <span className="font-medium text-foreground" data-testid="seat-usage">
                      Seats: {seats.seatsUsed} of {seats.seatLimit} used
                    </span>
                    .
                  </>
                )}
              </CardDescription>
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
                        options={roles}
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
              <CardDescription>
                They must already have a Money Matters account. Choose <span className="font-medium">Read only</span> to let
                someone look at the books at the same time as you without being able to change anything.
              </CardDescription>
            </CardHeader>
            {memberError && (
              <p role="alert" className="mx-6 mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {memberError}
              </p>
            )}
            {seats?.isFull && (
              <p className="mx-6 mb-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground" data-testid="seat-full">
                This account is at its seat limit ({seats.seatsUsed} of {seats.seatLimit} seats used). Additional
                seats will be available as a paid add-on. To request more seats, contact the platform administrator.
                Removing a member frees a seat.
              </p>
            )}
            <InviteMemberForm action={boundInvite} options={roles} defaultRole={DEFAULT_INVITE_ROLE} disabled={seats?.isFull} />
          </Card>
        </>
      )}
    </div>
  );
}
