import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { MetricsService } from "@/domain/platform-admin/metrics-service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat, Table, formatDate } from "./_components";

export default async function AdminDashboardPage() {
  const admin = await requirePlatformAdmin();
  const m = await MetricsService.getPlatformMetrics(admin.userId);
  const maxWeek = Math.max(1, ...m.signupsPerWeek.map((w) => w.users));

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Platform dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Platform-level counts only — derived from the users, organizations and memberships tables. No customer
          financial data is ever read here.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Users" value={m.users.total} hint={`${m.users.active} active · ${m.users.suspended} suspended`} />
        <Stat
          label="Organizations"
          value={m.organizations.total}
          hint={m.organizations.archived > 0 ? `${m.organizations.archived} archived` : "none archived"}
        />
        <Stat
          label="Seats used / allowed"
          value={`${m.seats.used} / ${m.seats.allowed}`}
          hint={`${m.seats.orgsAtLimit} org(s) at limit · ${m.seats.orgsOverLimit} over limit`}
        />
        <Stat
          label="Plan tiers"
          value={m.planTiers.length === 0 ? "—" : m.planTiers.map((t) => `${t.organizations} ${t.planTier}`).join(" · ")}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Signups per week</CardTitle>
            <CardDescription>Last 12 weeks (UTC, week starting Monday).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {m.signupsPerWeek.length === 0 && <p className="text-sm text-muted-foreground">No signups yet.</p>}
            {m.signupsPerWeek.map((w) => (
              <div key={w.period} className="flex items-center gap-3 text-xs">
                <span className="w-24 shrink-0 tabular-nums text-muted-foreground">{w.period}</span>
                <div className="h-3 flex-1 rounded bg-muted">
                  <div className="h-3 rounded bg-primary" style={{ width: `${(w.users / maxWeek) * 100}%` }} />
                </div>
                <span className="w-6 text-right tabular-nums">{w.users}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Signups per month</CardTitle>
            <CardDescription>Last 12 months (UTC).</CardDescription>
          </CardHeader>
          <CardContent>
            <Table head={["Month", "New users"]} empty="No signups yet.">
              {m.signupsPerMonth.map((r) => (
                <tr key={r.period}>
                  <td className="px-3 py-2 tabular-nums">{r.period}</td>
                  <td className="px-3 py-2 tabular-nums">{r.users}</td>
                </tr>
              ))}
            </Table>
          </CardContent>
        </Card>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Organizations at or over their seat limit</h2>
        <Table head={["Organization", "Plan", "Seats"]} empty="No organization is at its seat limit.">
          {m.orgsAtOrOverLimit.map((o) => (
            <tr key={o.id}>
              <td className="px-3 py-2">
                <Link href={`/admin/organizations/${o.id}`} className="font-medium hover:underline">
                  {o.name}
                </Link>{" "}
                <span className="text-xs text-muted-foreground">/{o.slug}</span>
              </td>
              <td className="px-3 py-2">{o.planTier}</td>
              <td className="px-3 py-2 tabular-nums">
                {o.seatsUsed} of {o.seatLimit}
                {o.seatsUsed > o.seatLimit && " (over)"}
              </td>
            </tr>
          ))}
        </Table>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Recent signups</h2>
          <Table head={["User", "Signed up"]} empty="No users yet.">
            {m.recentSignups.map((u) => (
              <tr key={u.id}>
                <td className="px-3 py-2">
                  <Link href={`/admin/users/${u.id}`} className="hover:underline">
                    {u.email}
                  </Link>
                  {u.disabledAt && <span className="ml-2 text-xs text-destructive">suspended</span>}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{formatDate(u.createdAt)}</td>
              </tr>
            ))}
          </Table>
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Recently suspended</h2>
          <Table head={["User", "Suspended"]} empty="Nobody is suspended.">
            {m.recentlySuspended.map((u) => (
              <tr key={u.id}>
                <td className="px-3 py-2">
                  <Link href={`/admin/users/${u.id}`} className="hover:underline">
                    {u.email}
                  </Link>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{formatDate(u.disabledAt)}</td>
              </tr>
            ))}
          </Table>
        </section>
      </div>
    </>
  );
}
