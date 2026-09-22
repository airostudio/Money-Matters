import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { ContactService } from "@/domain/contacts/contact-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default async function CustomersPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const customers = await ContactService.list(actor, { kind: "CUSTOMER" });
  const both = await ContactService.list(actor, { kind: "BOTH" });
  const all = [...customers, ...both].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const canManage = roleHasPermission(actor.role, "customer_invoice:manage");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-sm text-muted-foreground">Who you invoice.</p>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/sales/customers/new`}>
              <Plus /> New customer
            </Link>
          </Button>
        )}
      </div>

      {all.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No customers yet. Add one before creating an invoice.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Name</th>
                  <th className="px-6 py-2 font-medium">Email</th>
                  <th className="px-6 py-2 font-medium">Phone</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {all.map((c) => (
                  <tr key={c.id}>
                    <td className="px-6 py-2.5">
                      <Link href={`/${org.slug}/sales/customers/${c.id}`} className="font-medium hover:underline">
                        {c.displayName}
                      </Link>
                    </td>
                    <td className="px-6 py-2.5 text-muted-foreground">{c.email ?? "—"}</td>
                    <td className="px-6 py-2.5 text-muted-foreground">{c.phone ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
