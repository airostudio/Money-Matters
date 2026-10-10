import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { ContactService } from "@/domain/contacts/contact-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default async function SuppliersPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const suppliers = await ContactService.list(actor, { kind: "SUPPLIER" });
  const both = await ContactService.list(actor, { kind: "BOTH" });
  const all = [...suppliers, ...both].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const canManage = roleHasPermission(actor.role, "supplier_bill:manage");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
          <p className="text-sm text-muted-foreground">Who you owe money to.</p>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/purchases/suppliers/new`}>
              <Plus /> New supplier
            </Link>
          </Button>
        )}
      </div>

      {all.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No suppliers yet. Add one before creating a bill.
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
                      <Link href={`/${org.slug}/purchases/suppliers/${c.id}`} className="font-medium hover:underline">
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
