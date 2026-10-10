import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { MAX_OWNED_ACTIVE_COMPANIES } from "@/domain/organizations/limits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCompanyAction } from "../actions";

/** "Create a new company" under the signed-in login. The service enforces the cap and the throttle; this is the form. */
export default async function NewCompanyPage({ searchParams }: { searchParams: { error?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const error = typeof searchParams.error === "string" ? searchParams.error.slice(0, 600) : null;

  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>Create a new company</CardTitle>
          <CardDescription>
            A separate set of books under your existing login. You will be its owner, in its first seat, and go straight to its
            setup. Defaults match registration (Australia, AUD). You can own up to {MAX_OWNED_ACTIVE_COMPANIES} active companies;
            archived ones do not count.
          </CardDescription>
        </CardHeader>
        <form action={createCompanyAction}>
          <CardContent className="space-y-4">
            {error && (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="name">Company name</Label>
              <Input id="name" name="name" placeholder="Northstar Electrical Group" maxLength={200} required />
            </div>
          </CardContent>
          <CardFooter className="flex items-center gap-4">
            <Button type="submit">Create company</Button>
            <Link href="/app?all=1" className="text-sm text-muted-foreground underline">
              Cancel
            </Link>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
