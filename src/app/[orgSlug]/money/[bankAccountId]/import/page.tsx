import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { importStatementAction } from "../../actions";

export default async function ImportStatementPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; bankAccountId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const bankAccount = await BankAccountService.get(actor, params.bankAccountId);
  if (!bankAccount) notFound();

  const boundImport = importStatementAction.bind(null, params.orgSlug, params.bankAccountId);

  return (
    <div className="max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Import a statement — {bankAccount.name}</CardTitle>
        </CardHeader>
        <form action={boundImport} encType="multipart/form-data">
          <CardContent className="space-y-4">
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {searchParams.error}
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="file">Statement file</Label>
              <input
                id="file"
                name="file"
                type="file"
                accept=".csv,.ofx,.qfx,.qif,text/csv"
                required
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-xs"
              />
              <p className="text-xs text-muted-foreground">CSV, OFX, or QIF — the format is detected from the file extension.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="format">Format (only if detection is wrong)</Label>
              <select
                id="format"
                name="format"
                defaultValue=""
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Detect from file extension</option>
                <option value="CSV">CSV</option>
                <option value="OFX">OFX</option>
                <option value="QIF">QIF</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              Already-imported transactions are detected and skipped automatically — importing the same file
              twice is safe.
            </p>
          </CardContent>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button type="submit">Import</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
