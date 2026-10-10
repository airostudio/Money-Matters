import Link from "next/link";
import { redirect } from "next/navigation";
import { Archive, Plus } from "lucide-react";
import { getCurrentUser } from "@/lib/session";
import { isPlatformAdminUser } from "@/lib/platform-admin";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { MAX_OWNED_ACTIVE_COMPANIES } from "@/domain/organizations/limits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { joinCompanyAction, restoreCompanyAction } from "./actions";

/**
 * Landing spot after sign-in: resolves which organization(s) the user belongs to. Exactly one ACTIVE company and
 * nothing archived skips straight to its dashboard; otherwise the chooser shows. Archived companies never take part in
 * the redirect decision (a person whose only company is archived must land HERE, with the way back, not loop), and are
 * listed separately - with a Restore button for companies the user OWNS. (middleware.ts guarantees this route is only
 * reached by an authenticated session.)
 *
 * ONE membership query feeds all of it, including the owned-company count for the "Create a new company" cap.
 */
export default async function AppLandingPage({
  searchParams,
}: {
  searchParams: { error?: string; joinError?: string; all?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const all = await OrganizationService.listAllMembershipsForUser(user.id);
  const active = all.filter((m) => !m.organization.archivedAt);
  const archived = all.filter((m) => m.organization.archivedAt);

  if (all.length === 0 && isPlatformAdminUser(user)) {
    // A platform admin need not belong to any organization.
    redirect("/admin");
  }

  if (active.length === 1 && archived.length === 0 && searchParams.all !== "1") {
    redirect(`/${active[0]!.organization.slug}`);
  }

  const ownedActive = active.filter((m) => m.role === "OWNER").length;
  const atCompanyLimit = ownedActive >= MAX_OWNED_ACTIVE_COMPANIES;
  const error = typeof searchParams.error === "string" ? searchParams.error.slice(0, 600) : null;
  const joinError = typeof searchParams.joinError === "string" ? searchParams.joinError.slice(0, 600) : null;

  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="mb-6 text-xl font-semibold">{active.length > 0 ? "Choose a company" : "Welcome"}</h1>
      {error && (
        <p role="alert" className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {active.length === 0 && (
        <p className="mb-4 text-sm text-muted-foreground">
          You are not in any active company yet. Create one below, or join one with an invite code from its owner.
        </p>
      )}

      <div className="space-y-3">
        {active.map((m) => (
          <Link key={m.membershipId} href={`/${m.organization.slug}`}>
            <Card className="transition-colors hover:border-primary">
              <CardHeader>
                <CardTitle className="text-base">{m.organization.name}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 text-sm text-muted-foreground">Role: {m.role}</CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="mt-6 space-y-4 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Create a new company</p>
            <p className="text-xs text-muted-foreground">
              A separate set of books under this same login.
              {atCompanyLimit ? ` You already own ${MAX_OWNED_ACTIVE_COMPANIES} active companies, the maximum - archive one to make room.` : ""}
            </p>
          </div>
          {atCompanyLimit ? (
            <Button size="sm" disabled>
              <Plus /> Create a new company
            </Button>
          ) : (
            <Button asChild size="sm">
              <Link href="/app/new">
                <Plus /> Create a new company
              </Link>
            </Button>
          )}
        </div>

        <form action={joinCompanyAction} className="space-y-2 border-t border-border pt-4">
          <Label htmlFor="join-code">Join a company</Label>
          <p className="text-xs text-muted-foreground">
            Paste the invite code its owner gave you. It only works for the email address your account is registered with.
          </p>
          {joinError && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {joinError}
            </p>
          )}
          <div className="flex gap-2">
            <Input id="join-code" name="code" placeholder="mmj_…" autoComplete="off" spellCheck={false} required />
            <Button type="submit" variant="secondary">
              Join
            </Button>
          </div>
        </form>
      </div>

      {archived.length > 0 && (
        <section className="mt-8 space-y-3" aria-labelledby="archived-heading">
          <h2 id="archived-heading" className="flex items-center gap-2 text-sm font-semibold">
            <Archive className="size-4 text-muted-foreground" /> Archived companies
          </h2>
          <p className="text-xs text-muted-foreground">
            Archived companies are closed to everyone and paused (API keys, webhooks, automations) - nothing in them has been
            deleted. An owner can restore one at any time.
          </p>
          {archived.map((m) => (
            <div key={m.membershipId} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{m.organization.name}</p>
                <p className="text-xs text-muted-foreground">
                  {m.role === "OWNER" ? "You are an owner." : `Ask an owner to restore it (you are ${m.role.toLowerCase().replace("_", " ")}).`}
                </p>
              </div>
              {m.role === "OWNER" && (
                <form action={restoreCompanyAction}>
                  <input type="hidden" name="organizationId" value={m.organization.id} />
                  <Button type="submit" size="sm" variant="outline">
                    Restore
                  </Button>
                </form>
              )}
            </div>
          ))}
        </section>
      )}

      <p className="mt-6 text-sm text-muted-foreground">
        Several companies?{" "}
        <Link href="/app/groups" className="text-primary hover:underline">
          Consolidate them into one set of reports.
        </Link>
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Connected a third-party app?{" "}
        <Link href="/app/authorised-apps" className="text-primary hover:underline">
          See and remove the apps you have authorised.
        </Link>
      </p>
    </div>
  );
}
