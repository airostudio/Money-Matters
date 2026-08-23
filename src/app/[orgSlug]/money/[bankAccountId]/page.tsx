import Link from "next/link";
import { notFound } from "next/navigation";
import { Upload } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { ReconciliationService } from "@/domain/banking/reconciliation-service";
import { AccountService } from "@/domain/accounts/account-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  confirmMatchAction,
  createJournalFromTransactionAction,
  excludeTransactionAction,
} from "../actions";

function formatAmount(amount: string, currency: string): string {
  const value = Number(amount);
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)} ${currency}`;
}

export default async function BankAccountPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; bankAccountId: string };
  searchParams: { imported?: string; duplicates?: string; warnings?: string; error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const bankAccount = await BankAccountService.get(actor, params.bankAccountId);
  if (!bankAccount) notFound();

  const canReconcile = roleHasPermission(actor.role, "bank_transaction:reconcile");
  const canImport = roleHasPermission(actor.role, "bank_transaction:import");

  const [unreconciled, categorizeAccounts] = await Promise.all([
    ReconciliationService.listUnreconciled(actor, bankAccount.id),
    AccountService.list(actor),
  ]);

  const rows = await Promise.all(
    unreconciled.map(async (transaction) => ({
      transaction,
      candidates: canReconcile ? await ReconciliationService.findCandidateMatches(actor, transaction.id) : [],
    })),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/${org.slug}/money`} className="text-xs text-muted-foreground hover:underline">
            ← Money
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{bankAccount.name}</h1>
          <p className="text-sm text-muted-foreground">
            {bankAccount.institutionName ?? "Manually imported"} · {bankAccount.currency}
          </p>
        </div>
        {canImport && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/money/${bankAccount.id}/import`}>
              <Upload /> Import statement
            </Link>
          </Button>
        )}
      </div>

      {searchParams.imported && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
          Imported {searchParams.imported} transaction{searchParams.imported === "1" ? "" : "s"}
          {searchParams.duplicates && Number(searchParams.duplicates) > 0
            ? ` (${searchParams.duplicates} already on file, skipped).`
            : "."}
        </p>
      )}
      {searchParams.warnings && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
          {searchParams.warnings}
        </p>
      )}
      {searchParams.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
      )}

      <Card>
        <div className="border-b border-border px-6 py-3">
          <h2 className="text-sm font-semibold">
            {rows.length === 0 ? "Nothing to reconcile" : `${rows.length} to reconcile`}
          </h2>
        </div>
        {rows.length === 0 ? (
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Every imported transaction has been matched or posted.
          </CardContent>
        ) : (
          <div className="divide-y divide-border">
            {rows.map(({ transaction, candidates }) => {
              const topCandidate = candidates[0];
              return (
                <div key={transaction.id} className="space-y-3 px-6 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium">{transaction.description}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(transaction.postedDate).toLocaleDateString("en-AU")}
                      </p>
                    </div>
                    <p
                      className={
                        Number(transaction.amount) >= 0
                          ? "font-mono text-sm text-emerald-700 dark:text-emerald-400"
                          : "font-mono text-sm"
                      }
                    >
                      {formatAmount(transaction.amount, transaction.currency)}
                    </p>
                  </div>

                  {canReconcile && topCandidate && (
                    <div className="flex items-center justify-between gap-4 rounded-md bg-muted/50 px-3 py-2">
                      <div className="text-xs">
                        <span className="font-medium">
                          Likely match: {topCandidate.entryNumber} ({Math.round(topCandidate.confidence * 100)}%)
                        </span>
                        <p className="text-muted-foreground">{topCandidate.explanation}</p>
                      </div>
                      <form
                        action={confirmMatchAction.bind(
                          null,
                          org.slug,
                          bankAccount.id,
                          transaction.id,
                          topCandidate.journalLineId,
                        )}
                      >
                        <Button type="submit" size="sm" variant="outline">
                          Confirm match
                        </Button>
                      </form>
                    </div>
                  )}

                  {canReconcile && (
                    <div className="flex items-center gap-2">
                      <form
                        action={createJournalFromTransactionAction.bind(
                          null,
                          org.slug,
                          bankAccount.id,
                          transaction.id,
                        )}
                        className="flex flex-1 items-center gap-2"
                      >
                        <select
                          name="categorizedAccountId"
                          defaultValue={transaction.categorizedAccountId ?? ""}
                          required
                          className="flex h-8 w-full max-w-xs rounded-md border border-input bg-background px-2 text-xs"
                        >
                          <option value="" disabled>
                            Categorize to…
                          </option>
                          {categorizeAccounts
                            .filter((a) => a.id !== bankAccount.glAccountId)
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.code} — {a.name}
                              </option>
                            ))}
                        </select>
                        <Button type="submit" size="sm">
                          Post
                        </Button>
                      </form>
                      <form action={excludeTransactionAction.bind(null, org.slug, bankAccount.id, transaction.id)}>
                        <Button type="submit" size="sm" variant="ghost">
                          Exclude
                        </Button>
                      </form>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
