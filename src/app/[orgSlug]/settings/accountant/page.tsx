import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { PracticeConsentService } from "@/domain/practice/consent-service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { acceptAction, declineAction, revokeAction } from "./actions";

const STATUS_TEXT: Record<string, string> = {
  PENDING: "Waiting for your decision",
  ACTIVE: "Approved",
  DECLINED: "Declined",
  REVOKED: "Revoked",
  WITHDRAWN: "Ended by the practice",
};

/**
 * Accountant access: the CLIENT's side of the practice handshake. Only an Owner or Administrator
 * can see or change it. Nothing here gives a practice access to this organization's books by
 * itself — approving a practice only lets its staff read this organization if they are ALSO members
 * (with their own role, and using one of this organization's seats).
 */
export default async function AccountantAccessPage({ params, searchParams }: { params: { orgSlug: string }; searchParams: { error?: string } }) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);
  if (!roleHasPermission(actor.role, "organization:manage")) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Accountant access</h1>
        <p className="text-sm text-muted-foreground">Only an Owner or Administrator of {org.name} can manage accountant access.</p>
      </div>
    );
  }
  const consents = await PracticeConsentService.list(actor);
  const seats = await OrganizationService.getSeatUsage(org.id);
  const error = typeof searchParams.error === "string" ? searchParams.error.slice(0, 500) : null;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/settings`} className="hover:underline">
            Settings
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Accountant access</h1>
        <p className="text-sm text-muted-foreground">
          An accounting practice can ask to be linked to {org.name}. Approving lets staff of that practice read this organization&apos;s books <strong>only if they are also members of it</strong>,
          with their own role and its permissions. You can revoke at any moment — it takes effect on their very next read. The practice keeps its own working papers from the past, marked as of
          the date they were prepared, but can read nothing new.
        </p>
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Practices</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {consents.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No practice has asked to link to this organization.</p>
          ) : (
            <ul className="divide-y divide-border">
              {consents.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{c.practiceName}</p>
                    <p className="text-xs text-muted-foreground">
                      {STATUS_TEXT[c.status]} · requested {c.createdAt.slice(0, 10)} · practice reference {c.practiceId.slice(0, 8)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {(c.status === "PENDING" || c.status === "DECLINED" || c.status === "REVOKED") && (
                      <form action={acceptAction.bind(null, org.slug, c.id)}>
                        <Button type="submit" size="sm">
                          {c.status === "PENDING" ? "Accept" : "Approve again"}
                        </Button>
                      </form>
                    )}
                    {c.status === "PENDING" && (
                      <form action={declineAction.bind(null, org.slug, c.id)}>
                        <Button type="submit" size="sm" variant="outline">
                          Decline
                        </Button>
                      </form>
                    )}
                    {c.status === "ACTIVE" && (
                      <form action={revokeAction.bind(null, org.slug, c.id)}>
                        <Button type="submit" size="sm" variant="destructive">
                          Revoke access
                        </Button>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Giving a staff member access</CardTitle>
          <CardDescription>
            After you approve a practice, add each person who works on your books as a team member (an Accountant or Bookkeeper role is typical) under{" "}
            <Link href={`/${org.slug}/settings`} className="text-primary underline">
              Settings &gt; Team
            </Link>
            . Each uses one seat: {seats.seatsUsed} of {seats.seatLimit} seats are in use
            {seats.isFull ? " — your account is at its seat limit, so free a seat or ask the platform administrator to raise it. The limit is not bypassed for accountants." : "."}
          </CardDescription>
        </CardHeader>
      </Card>
      <p className="text-xs text-muted-foreground">
        Queries and document requests from an approved practice appear under{" "}
        <Link href={`/${org.slug}/requests`} className="text-primary underline">
          Requests from your accountant
        </Link>
        . A practice&apos;s internal notes, tasks and working papers are never shown to you.
      </p>
    </div>
  );
}
