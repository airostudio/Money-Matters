import Link from "next/link";
import { requireCurrentPractice, errorParam } from "../../require-practice";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { WorkpaperService } from "@/domain/practice/workpaper-service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/practice/light-badge";
import { createWorkpaperAction } from "../../actions";

function lastDayOfPreviousMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

export default async function NewWorkpaperPage({ searchParams }: { searchParams: { client?: string; error?: string } }) {
  const { actor, practice } = await requireCurrentPractice();
  const links = (await ClientLinkService.list(actor, practice.id, { statuses: ["ACTIVE"] }));
  const chosen = links.find((l) => l.clientOrganizationId === searchParams.client);
  let accounts: Awaited<ReturnType<typeof WorkpaperService.listClientAccounts>> = [];
  let problem: string | null = null;
  if (chosen) {
    try {
      accounts = await WorkpaperService.listClientAccounts(actor, practice.id, chosen.clientOrganizationId);
    } catch (error) {
      problem = error instanceof Error ? error.message : "The client's accounts could not be read.";
    }
  }
  const error = errorParam(searchParams.error);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/practice/workpapers" className="hover:underline">
            Workpapers
          </Link>{" "}
          / New
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">New workpaper</h1>
        <p className="text-sm text-muted-foreground">Balance-sheet account reconciliation. The account balance is read once, as at the period end, with your own role in that client.</p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Choose a client</CardTitle>
        </CardHeader>
        <CardContent>
          {links.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active clients. Link a client first.</p>
          ) : (
            <form className="flex items-end gap-2" method="get">
              <div className="flex-1 space-y-1">
                <Label htmlFor="client">Client</Label>
                <select id="client" name="client" defaultValue={chosen?.clientOrganizationId ?? ""} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option value="">Select…</option>
                  {links.map((l) => (
                    <option key={l.linkId} value={l.clientOrganizationId}>
                      {l.clientName}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" variant="outline">
                Load accounts
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      {problem && <Notice tone="warning">{problem}</Notice>}
      {chosen && !problem && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Account and period</CardTitle>
            <CardDescription>{chosen.clientName}</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={createWorkpaperAction} className="space-y-3">
              <input type="hidden" name="clientOrganizationId" value={chosen.clientOrganizationId} />
              <div className="space-y-1">
                <Label htmlFor="accountId">Balance-sheet account</Label>
                <select id="accountId" name="accountId" required className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name} ({a.type.toLowerCase()})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="periodEnd">Balance as at the end of</Label>
                <Input id="periodEnd" name="periodEnd" type="date" required defaultValue={lastDayOfPreviousMonth()} />
              </div>
              <Button type="submit">Create and pull the balance</Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
