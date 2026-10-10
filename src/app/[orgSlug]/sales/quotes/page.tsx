import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { QuoteService } from "@/domain/sales/quote-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { quoteStatusEnum } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";

type QuoteStatus = (typeof quoteStatusEnum.enumValues)[number];

export default async function QuotesPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { status?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const statusFilter =
    searchParams.status && quoteStatusEnum.enumValues.includes(searchParams.status as QuoteStatus)
      ? (searchParams.status as QuoteStatus)
      : undefined;

  const quotes = await QuoteService.list(actor, { status: statusFilter });
  const canManage = roleHasPermission(actor.role, "customer_quote:manage");
  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Quotes</h1>
          <p className="text-sm text-muted-foreground">
            Send a customer a price before they commit — accept it once and convert straight to an invoice.
          </p>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/sales/quotes/new`}>
              <Plus /> New quote
            </Link>
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Link
          href={`/${org.slug}/sales/quotes`}
          className={`rounded-full px-3 py-1 ${!statusFilter ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
        >
          All
        </Link>
        {quoteStatusEnum.enumValues.map((s) => (
          <Link
            key={s}
            href={`/${org.slug}/sales/quotes?status=${s}`}
            className={`rounded-full px-3 py-1 capitalize ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
          >
            {s.toLowerCase().replace(/_/g, " ")}
          </Link>
        ))}
      </div>

      {quotes.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">No quotes to show.</CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Quote</th>
                  <th className="px-6 py-2 font-medium">Customer</th>
                  <th className="px-6 py-2 font-medium">Expires</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {quotes.map((q) => {
                  const isExpired = q.status === "SENT" && new Date(q.expiryDate) < now;
                  return (
                    <tr key={q.id}>
                      <td className="px-6 py-2.5">
                        <Link href={`/${org.slug}/sales/quotes/${q.id}`} className="font-medium hover:underline">
                          {q.quoteNumber}
                        </Link>
                      </td>
                      <td className="px-6 py-2.5">{q.customer.displayName}</td>
                      <td className="px-6 py-2.5 text-muted-foreground">
                        {new Date(q.expiryDate).toLocaleDateString("en-AU")}
                      </td>
                      <td className="px-6 py-2.5">
                        <StatusBadge status={isExpired ? "EXPIRED" : q.status} />
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        <MoneyDisplay amount={q.total} currency={q.currency} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
