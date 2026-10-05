import Link from "next/link";
import { requireCurrentPractice, errorParam } from "../require-practice";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { ClientGroupService } from "@/domain/practice/client-group-service";
import { PracticeService } from "@/domain/practice/practice-service";
import { loadClientAccessMap } from "@/domain/practice/client-access";
import { practiceRoleAtLeast } from "@/domain/practice/practice-access";
import { DASHBOARD_PAGE_SIZE, MAX_CLIENTS_PER_PRACTICE } from "@/domain/practice/types";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/practice/light-badge";
import { assignClientAction, createGroupAction, deleteGroupAction, proposeLinkAction, verifyLinksAction, withdrawLinkAction } from "../actions";

const STATUS_TEXT: Record<string, string> = {
  PENDING: "Waiting for the client to accept",
  ACTIVE: "Active",
  DECLINED: "Declined by the client",
  REVOKED: "Revoked by the client",
  WITHDRAWN: "Ended by your practice",
};

export default async function ClientsPage({ searchParams }: { searchParams: { error?: string; notice?: string } }) {
  const { actor, practice } = await requireCurrentPractice();
  const isManager = practiceRoleAtLeast(practice.role, "MANAGER");
  const isPartner = practice.role === "PARTNER";

  // Learn about acceptances/revocations first (the client's own record is authoritative):
  // at most one page of the non-final links, checked one at a time.
  const before = await ClientLinkService.list(actor, practice.id);
  const toCheck = before.filter((l) => l.status === "PENDING" || l.status === "ACTIVE").slice(0, DASHBOARD_PAGE_SIZE);
  if (toCheck.length > 0) await ClientLinkService.verify(actor, practice.id, toCheck.map((l) => l.clientOrganizationId));
  const links = await ClientLinkService.list(actor, practice.id);
  const groups = await ClientGroupService.list(actor, practice.id);
  const staff = await PracticeService.listStaff(actor, practice.id);
  const access = await loadClientAccessMap(actor.userId);

  // Seat position for the (at most a few) active clients the viewer cannot open — bounded.
  const blocked = links.filter((l) => l.status === "ACTIVE" && !access.has(l.clientOrganizationId)).slice(0, 10);
  const seats = new Map<string, { used: number; limit: number }>();
  for (const l of blocked) {
    const s = await OrganizationService.getSeatUsage(l.clientOrganizationId).catch(() => null);
    if (s) seats.set(l.clientOrganizationId, { used: s.seatsUsed, limit: s.seatLimit });
  }
  const error = errorParam(searchParams.error);
  const notice = typeof searchParams.notice === "string" ? searchParams.notice.slice(0, 600) : null;
  const live = links.filter((l) => l.status === "ACTIVE" || l.status === "PENDING").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <p className="text-sm text-muted-foreground">
          A client link is a two-sided agreement. You propose it with the client&apos;s organization slug; the client&apos;s <strong>owner or administrator</strong> accepts
          it from Settings &gt; Accountant access, and can revoke it at any moment (it takes effect on the very next read). A link by itself gives you
          no access to the books: you also need to be a member of the client&apos;s organization, with a role (for example Accountant or Bookkeeper) that allows what you do.
        </p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}

      {isManager && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Link a client</CardTitle>
            <CardDescription>
              {live} of {MAX_CLIENTS_PER_PRACTICE} client links in use. Ask the client for their organization slug (the part of their Money Matters web address after the
              domain).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={proposeLinkAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <Label htmlFor="slug">Client organization slug</Label>
                <Input id="slug" name="slug" required placeholder="acme-plumbing" />
              </div>
              <Button type="submit">Send link request</Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Your clients</CardTitle>
          <form action={verifyLinksAction}>
            {toCheck.map((l) => (
              <input key={l.linkId} type="hidden" name="clientId" value={l.clientOrganizationId} />
            ))}
            <Button type="submit" size="sm" variant="outline">
              Check status with clients
            </Button>
          </form>
        </CardHeader>
        <CardContent className="p-0">
          {links.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No client links yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {links.map((l) => {
                const member = access.get(l.clientOrganizationId);
                const seat = seats.get(l.clientOrganizationId);
                return (
                  <div key={l.linkId} className="space-y-2 px-6 py-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        {l.status === "ACTIVE" ? (
                          <Link href={`/practice/clients/${l.clientOrganizationId}`} className="font-medium text-primary hover:underline">
                            {l.clientName}
                          </Link>
                        ) : (
                          <span className="font-medium">{l.clientName}</span>
                        )}
                        <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{STATUS_TEXT[l.status]}</span>
                        {l.groups.length > 0 && <span className="ml-2 text-xs text-muted-foreground">{l.groups.map((g) => g.name).join(", ")}</span>}
                      </div>
                      {(l.status === "ACTIVE" || l.status === "PENDING") && (isPartner || (l.status === "PENDING" && isManager)) && (
                        <form action={withdrawLinkAction.bind(null, l.clientOrganizationId)}>
                          <Button type="submit" size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                            {l.status === "PENDING" ? "Withdraw request" : "End link"}
                          </Button>
                        </form>
                      )}
                    </div>
                    {l.status === "ACTIVE" && (
                      <p className="text-xs text-muted-foreground">
                        {member ? (
                          <>You are a member of {l.clientName} as {member.role.toLowerCase().replace("_", " ")}.</>
                        ) : (
                          <>
                            You are not a member of {l.clientName}, so you cannot read its books. Ask its owner or administrator to add you as an Accountant or Bookkeeper
                            {seat
                              ? seat.used >= seat.limit
                                ? `. It is at its seat limit (${seat.used} of ${seat.limit} seats used): a seat must be freed first, or the platform administrator can raise the limit for that organization. The limit is not bypassed.`
                                : `. That uses one of its seats (${seat.used} of ${seat.limit} used).`
                              : "."}
                          </>
                        )}
                      </p>
                    )}
                    {l.status === "DECLINED" && <p className="text-xs text-muted-foreground">Only the client&apos;s owner or administrator can re-approve this from their settings.</p>}
                    {isManager && (l.status === "ACTIVE" || l.status === "PENDING") && (
                      <form action={assignClientAction.bind(null, l.clientOrganizationId)} className="flex items-center gap-2">
                        <label htmlFor={`assignee-${l.linkId}`} className="text-xs text-muted-foreground">
                          Responsible
                        </label>
                        <select id={`assignee-${l.linkId}`} name="assigneeUserId" defaultValue={l.assignedUserId ?? ""} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                          <option value="">Unassigned</option>
                          {staff.map((s) => (
                            <option key={s.userId} value={s.userId}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                        <Button type="submit" size="sm" variant="outline">
                          Save
                        </Button>
                        <span className="text-xs text-muted-foreground">Assignment gives no access to the client.</span>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Client groups</CardTitle>
          <CardDescription>Your own labels (for example &quot;Monthly BAS&quot;, &quot;Hospitality&quot;). Clients are never told which groups they are in. Apply a group to selected clients from the dashboard.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No groups yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {groups.map((g) => (
                <li key={g.id} className="flex items-center justify-between py-2">
                  <span>
                    {g.name} <span className="text-xs text-muted-foreground">({g.clientCount} client{g.clientCount === 1 ? "" : "s"})</span>
                  </span>
                  {isManager && (
                    <form action={deleteGroupAction.bind(null, g.id)}>
                      <Button type="submit" size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                        Delete
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {isManager && (
            <form action={createGroupAction} className="flex items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="group-name">New group</Label>
                <Input id="group-name" name="name" required maxLength={60} placeholder="Monthly BAS" />
              </div>
              <Button type="submit" size="sm">
                Add group
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
