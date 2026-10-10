import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { OAuthGrantService } from "@/domain/oauth/grant-service";
import { SCOPE_INFO, isApiScope } from "@/domain/api/scopes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { revokeOwnGrantAction } from "./actions";

export const dynamic = "force-dynamic";

const formatDate = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : "-");

/**
 * "Authorised apps": every third-party app the signed-in person has connected, in every company they belong to, with a
 * Remove button for each. ANY member sees their own list (this is not a permission: withdrawing your own consent never is).
 * Organizations are read ONE AT A TIME (never concurrently) through the person's real membership; archived companies are
 * skipped because nothing can act in them. Revoking is immediate and kills the app's access and refresh tokens.
 */
export default async function AuthorisedAppsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=%2Fapp%2Fauthorised-apps");

  const sections = await OAuthGrantService.listOwnAcrossOrganizations(user.id);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-12">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/app" className="hover:underline">
            Your companies
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Authorised apps</h1>
        <p className="text-sm text-muted-foreground">
          Apps you have allowed to use a company&apos;s data on your behalf. Removing one signs it out immediately; it can only come back if you approve it again. An app can only do what your role in that company allows, and it can never post, approve, pay or delete anything.
        </p>
      </div>

      {sections.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">You have not authorised any apps.</CardContent>
        </Card>
      ) : (
        sections.map((section) => (
          <Card key={section.organizationId}>
            <CardHeader>
              <CardTitle className="text-base">{section.organizationName}</CardTitle>
              <CardDescription>
                {section.grants.length} app{section.grants.length === 1 ? "" : "s"}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-border" data-testid="authorised-app-list">
                {section.grants.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-start justify-between gap-3 px-6 py-4 text-sm">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">{g.appName}</p>
                      <ul className="list-disc pl-5 text-xs text-muted-foreground">
                        {g.scopes.map((scope) => (
                          <li key={scope}>{isApiScope(scope) ? SCOPE_INFO[scope].label : scope}</li>
                        ))}
                      </ul>
                      <p className="text-xs text-muted-foreground">
                        Allowed {formatDate(g.createdAt)}
                        {g.lastRefreshedAt ? ` - last active ${formatDate(g.lastRefreshedAt)}` : ""}
                      </p>
                    </div>
                    <form action={revokeOwnGrantAction}>
                      <input type="hidden" name="organizationId" value={section.organizationId} />
                      <input type="hidden" name="grantId" value={g.id} />
                      <Button type="submit" size="sm" variant="destructive">
                        Remove access
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
