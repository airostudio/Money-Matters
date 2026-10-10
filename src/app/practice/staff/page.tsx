import { requireCurrentPractice, errorParam } from "../require-practice";
import { PracticeService } from "@/domain/practice/practice-service";
import { MAX_PRACTICE_STAFF, PRACTICE_ROLE_LABELS } from "@/domain/practice/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/practice/light-badge";
import { addStaffAction, changeRoleAction, removeStaffAction } from "../actions";

export default async function StaffPage({ searchParams }: { searchParams: { error?: string; notice?: string } }) {
  const { user, actor, practice } = await requireCurrentPractice();
  const staff = await PracticeService.listStaff(actor, practice.id);
  const isPartner = practice.role === "PARTNER";
  const error = errorParam(searchParams.error);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>
        <p className="text-sm text-muted-foreground">
          {staff.length} of {MAX_PRACTICE_STAFF} staff. Joining the practice gives a person <strong>no access to any client&apos;s books</strong>: each client&apos;s owner or
          administrator must also add them as a member of that client&apos;s organization (which uses one of that client&apos;s seats). Partners manage staff; a partner can only
          step down or leave themselves, and a practice always keeps at least one partner.
        </p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {staff.map((s) => (
              <li key={s.userId} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {s.name} {s.userId === user.id && <span className="text-xs text-muted-foreground">(you)</span>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{s.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  {isPartner && (s.role !== "PARTNER" || s.userId === user.id) ? (
                    <form action={changeRoleAction.bind(null, s.userId)} className="flex items-center gap-1">
                      <label htmlFor={`role-${s.userId}`} className="sr-only">
                        Role for {s.name}
                      </label>
                      <select id={`role-${s.userId}`} name="role" defaultValue={s.role} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                        {(["PARTNER", "MANAGER", "STAFF"] as const).map((r) => (
                          <option key={r} value={r}>
                            {PRACTICE_ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                      <Button type="submit" size="sm" variant="outline">
                        Save
                      </Button>
                    </form>
                  ) : (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{PRACTICE_ROLE_LABELS[s.role]}</span>
                  )}
                  {(s.userId === user.id || (isPartner && s.role !== "PARTNER")) && (
                    <form action={removeStaffAction.bind(null, s.userId)}>
                      <Button type="submit" size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                        {s.userId === user.id ? "Leave practice" : "Remove"}
                      </Button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {isPartner && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a colleague</CardTitle>
            <CardDescription>They must already have a Money Matters account.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={addStaffAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" required placeholder="colleague@example.com" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="role">Practice role</Label>
                <select id="role" name="role" defaultValue="STAFF" className="flex h-9 w-36 rounded-md border border-input bg-background px-3 text-sm">
                  {(["STAFF", "MANAGER", "PARTNER"] as const).map((r) => (
                    <option key={r} value={r}>
                      {PRACTICE_ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit">Add</Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
