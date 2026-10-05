import Link from "next/link";
import { notFound } from "next/navigation";
import { requireGroupUser } from "../../require-user";
import { GroupService } from "@/domain/consolidation/group-service";
import { GroupNotFoundError } from "@/domain/consolidation/errors";
import { createAccountResolver } from "@/domain/consolidation/account-mapping";
import { INTERCOMPANY_KIND_ACCOUNT_TYPE, type IntercompanyKind } from "@/domain/consolidation/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addGroupAccountAction, designateIntercompanyAction, mapAccountAction, removeGroupAccountAction } from "../../actions";

const KIND_LABEL: Record<IntercompanyKind, string> = {
  RECEIVABLE: "Intercompany receivable",
  PAYABLE: "Intercompany payable",
  LOAN_RECEIVABLE: "Intercompany loan receivable",
  LOAN_PAYABLE: "Intercompany loan payable",
  REVENUE: "Intercompany revenue",
  EXPENSE: "Intercompany expense",
};

export default async function GroupSetupPage({ params, searchParams }: { params: { groupId: string }; searchParams: { error?: string } }) {
  const { actor } = await requireGroupUser();

  let detail;
  try {
    detail = await GroupService.get(actor, params.groupId);
  } catch (error) {
    if (error instanceof GroupNotFoundError) notFound();
    throw error;
  }
  const charts = await GroupService.listManageableEntityCharts(actor, params.groupId);
  const groupAccounts = detail.config.groupAccounts;
  const resolve = createAccountResolver(groupAccounts, detail.config.mappings);
  const explicit = new Map(detail.config.mappings.map((m) => [`${m.organizationId}|${m.accountId}`, m.groupAccountId]));
  const designated = new Map(detail.config.intercompany.map((i) => [`${i.organizationId}|${i.accountId}`, i]));
  const counterparties = detail.members.filter((m) => m.accessible);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/app/groups" className="hover:underline">
            Entity groups
          </Link>{" "}
          /{" "}
          <Link href={`/app/groups/${params.groupId}`} className="hover:underline">
            {detail.group.name}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Account mapping &amp; intercompany</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Each entity has its own chart of accounts. A consolidated line is a <strong>group account</strong>; an entity account reports under the
          group account with the <em>same type and code</em> unless you map it elsewhere. An account that matches nothing sits in an explicit
          &ldquo;Unmapped&rdquo; bucket — still counted, never dropped. Accounts designated as intercompany are matched with the named counterparty
          entity and eliminated; any difference is reported, not forced to zero.
        </p>
      </div>

      {searchParams.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Group chart of accounts ({groupAccounts.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form action={addGroupAccountAction.bind(null, params.groupId)} className="flex flex-wrap items-end gap-3">
            <select name="type" className="h-9 rounded-md border border-input bg-background px-3 text-sm" defaultValue="ASSET">
              {["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"].map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0) + t.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
            <Input name="code" required placeholder="Code" className="w-28" />
            <Input name="name" required placeholder="Name" className="w-64" />
            <Button type="submit" size="sm">
              Add group account
            </Button>
          </form>
          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {groupAccounts.map((g) => (
                  <tr key={g.id}>
                    <td className="px-4 py-1.5 font-mono text-xs text-muted-foreground">{g.code}</td>
                    <td className="px-4 py-1.5">{g.name}</td>
                    <td className="px-4 py-1.5 text-xs text-muted-foreground">{g.type.toLowerCase()}</td>
                    <td className="px-4 py-1.5 text-right">
                      <form action={removeGroupAccountAction.bind(null, params.groupId, g.id)}>
                        <Button type="submit" size="sm" variant="ghost">
                          Remove
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
                {groupAccounts.length === 0 && (
                  <tr>
                    <td className="px-4 py-4 text-center text-muted-foreground">Add an entity to the group to seed this chart from its accounts.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {charts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          None of the group&apos;s entities lets you manage its mapping (you need the consolidation permission — Owner, Administrator or Accountant — in an entity).
        </p>
      )}

      {charts.map((chart) => (
        <Card key={chart.organizationId}>
          <CardHeader>
            <CardTitle className="text-base">{chart.name}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium">Reports under</th>
                  <th className="px-4 py-2 font-medium">Intercompany</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {chart.accounts.map((a) => {
                  const resolution = resolve(chart.organizationId, { accountId: a.id, code: a.code, type: a.type });
                  const explicitId = explicit.get(`${chart.organizationId}|${a.id}`) ?? "";
                  const designation = designated.get(`${chart.organizationId}|${a.id}`);
                  const kinds = (Object.keys(INTERCOMPANY_KIND_ACCOUNT_TYPE) as IntercompanyKind[]).filter((k) => INTERCOMPANY_KIND_ACCOUNT_TYPE[k] === a.type);
                  return (
                    <tr key={a.id} className={resolution.kind === "UNMAPPED" ? "bg-amber-500/5" : undefined}>
                      <td className="px-4 py-2 align-top">
                        <span className="font-mono text-xs text-muted-foreground">{a.code}</span> {a.name}
                        <div className="text-xs text-muted-foreground">{a.type.toLowerCase()}</div>
                      </td>
                      <td className="px-4 py-2 align-top">
                        <form action={mapAccountAction.bind(null, params.groupId, chart.organizationId, a.id)} className="flex items-center gap-2">
                          <select name="groupAccountId" defaultValue={explicitId} className="h-8 max-w-[16rem] rounded-md border border-input bg-background px-2 text-xs">
                            <option value="">
                              {resolution.kind === "MAPPED" && resolution.via === "DEFAULT"
                                ? `Default: ${resolution.groupAccount.code} ${resolution.groupAccount.name}`
                                : "Unmapped (no matching group account)"}
                            </option>
                            {groupAccounts
                              .filter((g) => g.type === a.type)
                              .map((g) => (
                                <option key={g.id} value={g.id}>
                                  {g.code} {g.name}
                                </option>
                              ))}
                          </select>
                          <Button type="submit" size="sm" variant="ghost">
                            Save
                          </Button>
                        </form>
                      </td>
                      <td className="px-4 py-2 align-top">
                        {kinds.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <form action={designateIntercompanyAction.bind(null, params.groupId, chart.organizationId, a.id)} className="flex flex-wrap items-center gap-2">
                            <select name="kind" defaultValue={designation?.kind ?? ""} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                              <option value="">Not intercompany</option>
                              {kinds.map((k) => (
                                <option key={k} value={k}>
                                  {KIND_LABEL[k]}
                                </option>
                              ))}
                            </select>
                            <select name="counterpartyOrganizationId" defaultValue={designation?.counterpartyOrganizationId ?? ""} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                              <option value="">with…</option>
                              {counterparties
                                .filter((c) => c.organizationId !== chart.organizationId)
                                .map((c) => (
                                  <option key={c.organizationId} value={c.organizationId}>
                                    {c.name}
                                  </option>
                                ))}
                            </select>
                            <Button type="submit" size="sm" variant="ghost">
                              Save
                            </Button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
