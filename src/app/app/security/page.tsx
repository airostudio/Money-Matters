import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { recentSignIns } from "@/domain/auth/auth-events";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/**
 * The signed-in person's own security page: recent sign-ins (with a "new browser or network" flag) and, as the other
 * login-security slices land, two-step verification and email status. Platform-level data only (docs/security.md s.22).
 */
export default async function SecurityPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/app/security");

  const signIns = await recentSignIns(user.id, 8);
  const latestIsNew = signIns[0]?.newDevice === true;

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-12">
      <div>
        <Link href="/app" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Back
        </Link>
        <h1 className="mt-2 text-xl font-semibold">Account security</h1>
        <p className="text-sm text-muted-foreground">{user.email}</p>
      </div>

      {latestIsNew && (
        <p role="status" className="rounded-md bg-warning/10 px-3 py-2 text-sm text-foreground">
          Your latest sign-in was from a browser or network we had not seen before. If that was not you, change your
          password and review the list below.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent sign-ins</CardTitle>
          <CardDescription>
            Only a coarse browser label and a time are kept. Network addresses are stored as one-way hashes, never as text.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {signIns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sign-ins recorded yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {signIns.map((s, i) => (
                <li key={`${s.at.toISOString()}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{s.userAgentFamily ?? "Unknown browser"}</span>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    {s.newDevice && <span className="rounded bg-warning/10 px-1.5 py-0.5 text-xs text-foreground">New browser or network</span>}
                    {s.at.toLocaleString("en-AU", { timeZone: "UTC" })} UTC
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
