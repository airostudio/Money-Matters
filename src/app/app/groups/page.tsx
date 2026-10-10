import Link from "next/link";
import { requireGroupUser } from "./require-user";
import { GroupService } from "@/domain/consolidation/group-service";
import { MAX_ENTITIES_PER_GROUP } from "@/domain/consolidation/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createGroupAction } from "./actions";

export default async function GroupsPage({ searchParams }: { searchParams: { error?: string } }) {
  const { actor } = await requireGroupUser();
  const groups = await GroupService.list(actor);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Entity groups</h1>
        <p className="text-sm text-muted-foreground">
          Consolidate several companies you belong to into one set of reports. A group is private to you: it lists
          organizations you are a member of, and every consolidated figure is built one entity at a time using your own
          role in that entity — an entity you cannot read is left out and reported as excluded.
        </p>
      </div>

      {searchParams.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      )}

      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your groups</CardTitle>
          </CardHeader>
          <CardContent>
            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">No groups yet. Create one to start consolidating.</p>
            ) : (
              <ul className="divide-y divide-border">
                {groups.map((g) => (
                  <li key={g.id} className="flex items-center justify-between py-3">
                    <div>
                      <Link href={`/app/groups/${g.id}`} className="font-medium text-primary hover:underline">
                        {g.name}
                      </Link>
                      {g.description && <p className="text-xs text-muted-foreground">{g.description}</p>}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {g.memberCount} of {MAX_ENTITIES_PER_GROUP} entities
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">New group</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={createGroupAction} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required placeholder="Smith Family Holdings" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="description">Description (optional)</Label>
                <Input id="description" name="description" />
              </div>
              <Button type="submit">Create group</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
