import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Landing spot after sign-in: resolves which organization(s) the user
 * belongs to. A single membership skips straight to its dashboard; more
 * than one shows a switcher. (middleware.ts guarantees this route is only
 * reached by an authenticated session.)
 */
export default async function AppLandingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const memberships = await OrganizationService.listMembershipsForUser(user.id);

  if (memberships.length === 0) {
    redirect("/register");
  }

  if (memberships.length === 1) {
    redirect(`/${memberships[0]!.organization.slug}`);
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="mb-6 text-xl font-semibold">Choose an organization</h1>
      <div className="space-y-3">
        {memberships.map((m) => (
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
    </div>
  );
}
