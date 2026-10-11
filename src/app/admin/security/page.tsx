import { requirePlatformAdmin } from "@/lib/platform-admin";
import { recentLockouts } from "@/domain/auth/auth-events";
import { Table, formatDate } from "../_components";

/** Recent sign-in lockouts (account or address). Read-only; platform-level data, nothing tenant-scoped. */
export default async function AdminSecurityPage() {
  await requirePlatformAdmin();
  const rows = await recentLockouts(50);

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Sign-in security</h1>
        <p className="text-sm text-muted-foreground">
          The 50 most recent sign-in lockouts (5 failures in 15 minutes locks an account for 15 minutes, doubling on each
          repeat; 30 failures locks an address). Emails and addresses are stored only as keyed hashes, so an unknown
          email shows no account. Refused attempts while locked are not logged.
        </p>
      </div>
      <Table head={["When", "Scope", "Account key", "Browser"]} empty="No lockouts recorded.">
        {rows.map((r, i) => (
          <tr key={`${r.at.toISOString()}-${i}`}>
            <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatDate(r.at)}</td>
            <td className="px-3 py-2">{r.detail === "address" ? "Network address" : "Account"}</td>
            <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.accountKey ?? "n/a"}</td>
            <td className="px-3 py-2 text-muted-foreground">{r.userAgentFamily ?? "Unknown"}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
