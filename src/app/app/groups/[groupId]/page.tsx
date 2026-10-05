import Link from "next/link";
import { notFound } from "next/navigation";
import { requireGroupUser } from "../require-user";
import { GroupService } from "@/domain/consolidation/group-service";
import { GroupNotFoundError } from "@/domain/consolidation/errors";
import { MAX_ENTITIES_PER_GROUP } from "@/domain/consolidation/types";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  addEntityAction,
  archiveGroupAction,
  removeEntityAction,
  setIncludedAction,
  setRoleAction,
} from "../actions";

export default async function GroupPage({ params, searchParams }: { params: { groupId: string }; searchParams: { error?: string } }) {
  const { actor, user } = await requireGroupUser();

  let detail;
  try {
    detail = await GroupService.get(actor, params.groupId);
  } catch (error) {
    if (error instanceof GroupNotFoundError) notFound();
    throw error;
  }
  const memberships = await OrganizationService.listMembershipsForUser(user.id);
  const inGroup = new Set(detail.members.map((m) => m.organizationId));
  const candidates = memberships.filter((m) => !inGroup.has(m.organization.id));

  const readable = detail.members.filter((m) => m.accessible && m.isIncluded);
  const currencies = [...new Set(readable.map((m) => m.baseCurrency).filter(Boolean))] as string[];
  const unavailable = detail.members.filter((m) => !m.accessible && m.isIncluded).length;
  const base = `/app/groups/${detail.group.id}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href="/app/groups" className="hover:underline">
              Entity groups
            </Link>{" "}
            / {detail.group.name}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{detail.group.name}</h1>
          {detail.group.description && <p className="text-sm text-muted-foreground">{detail.group.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href={`${base}/reports/balance-sheet`}>Balance Sheet</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={`${base}/reports/profit-and-loss`}>Profit &amp; Loss</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={`${base}/reports/cash`}>Cash</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={`${base}/setup`}>Mapping &amp; intercompany</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={`${base}/adjustments`}>Adjustments</Link>
          </Button>
        </div>
      </div>

      {searchParams.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      )}

      {currencies.length > 1 && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          These entities have different base currencies: {[...currencies].sort().join(", ")} — currency translation is not yet supported, so
          consolidated reports will be refused until the group holds entities in one base currency.
        </p>
      )}
      {unavailable > 0 && (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          {unavailable} {unavailable === 1 ? "entity" : "entities"} in this group {unavailable === 1 ? "is" : "are"} no longer accessible to you and will be excluded from every
          report. You can remove {unavailable === 1 ? "it" : "them"} below.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Entities ({detail.members.length} of {MAX_ENTITIES_PER_GROUP})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-6 py-2 font-medium">Entity</th>
                <th className="px-6 py-2 font-medium">Role in group</th>
                <th className="px-6 py-2 font-medium">Your role</th>
                <th className="px-6 py-2 font-medium">In reports</th>
                <th className="px-6 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {detail.members.map((m) => (
                <tr key={m.memberId}>
                  <td className="px-6 py-2.5">
                    {m.accessible ? (
                      <Link href={`/${m.slug}`} className="text-primary hover:underline">
                        {m.name}
                      </Link>
                    ) : (
                      <span className="italic text-muted-foreground">Entity no longer accessible</span>
                    )}
                    {m.baseCurrency && <span className="ml-2 text-xs text-muted-foreground">{m.baseCurrency}</span>}
                  </td>
                  <td className="px-6 py-2.5">
                    <form action={setRoleAction.bind(null, detail.group.id, m.organizationId)} className="flex items-center gap-2">
                      <select name="role" defaultValue={m.role} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                        <option value="PARENT">Parent</option>
                        <option value="SUBSIDIARY">Subsidiary</option>
                      </select>
                      <Button type="submit" size="sm" variant="ghost">
                        Set
                      </Button>
                    </form>
                  </td>
                  <td className="px-6 py-2.5 text-muted-foreground">
                    {m.userRole ?? "—"}
                    {m.userRole && !roleHasPermission(m.userRole as never, "financial_report:read") && (
                      <span className="ml-2 text-xs text-destructive">cannot read reports — excluded</span>
                    )}
                  </td>
                  <td className="px-6 py-2.5">
                    <form action={setIncludedAction.bind(null, detail.group.id, m.organizationId, !m.isIncluded)}>
                      <Button type="submit" size="sm" variant={m.isIncluded ? "secondary" : "outline"}>
                        {m.isIncluded ? "Included" : "Switched off"}
                      </Button>
                    </form>
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    <form action={removeEntityAction.bind(null, detail.group.id, m.organizationId)}>
                      <Button type="submit" size="sm" variant="ghost">
                        Remove
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
              {detail.members.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-6 text-center text-muted-foreground">
                    No entities yet. Add the first one below — it becomes the parent and seeds the group chart of accounts.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add an entity</CardTitle>
        </CardHeader>
        <CardContent>
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every organization you belong to is already in this group.</p>
          ) : (
            <form action={addEntityAction.bind(null, detail.group.id)} className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label htmlFor="organizationId" className="text-xs font-medium text-muted-foreground">
                  Organization
                </label>
                <select id="organizationId" name="organizationId" className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                  {candidates.map((c) => (
                    <option key={c.organization.id} value={c.organization.id}>
                      {c.organization.name} (you are {c.role})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="role" className="text-xs font-medium text-muted-foreground">
                  Role in group
                </label>
                <select id="role" name="role" defaultValue="" className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">Automatic</option>
                  <option value="PARENT">Parent</option>
                  <option value="SUBSIDIARY">Subsidiary</option>
                </select>
              </div>
              <Button type="submit">Add</Button>
            </form>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Adding an entity requires the consolidation permission in that entity (Owner, Administrator or Accountant). Entities are
            owned 100% by the group — partial ownership and non-controlling interests are not supported.
          </p>
        </CardContent>
      </Card>

      <form action={archiveGroupAction.bind(null, detail.group.id)}>
        <Button type="submit" variant="ghost" size="sm" className="text-destructive">
          Archive this group
        </Button>
      </form>
    </div>
  );
}
