import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { ClientRequestService } from "@/domain/client-requests/client-request-service";
import { Card, CardContent } from "@/components/ui/card";

const STATUS_TEXT: Record<string, string> = { OPEN: "Waiting for you", ANSWERED: "You replied", CLOSED: "Closed" };

/**
 * "Requests from your accountant": queries and document requests an accountant practice (which you
 * have approved under Settings > Accountant access) has raised with you. They appear here, in the
 * app, only — there is no email or notification system yet, so check back or ask your accountant to let you know.
 */
export default async function RequestsPage({ params }: { params: { orgSlug: string } }) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);
  if (!roleHasPermission(actor.role, "client_request:read")) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Requests from your accountant</h1>
        <p className="text-sm text-muted-foreground">Your role in {org.name} does not include the accountant requests inbox. Ask an owner or administrator.</p>
      </div>
    );
  }
  const requests = await ClientRequestService.list(actor);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Requests from your accountant</h1>
        <p className="text-sm text-muted-foreground">
          Questions and document requests from an accountant practice you have approved. They show up here in the app only — there are no email notifications yet.
        </p>
      </div>
      <Card>
        <CardContent className="p-0">
          {requests.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No requests.</p>
          ) : (
            <ul className="divide-y divide-border">
              {requests.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                  <div className="min-w-0">
                    <Link href={`/${org.slug}/requests/${r.id}`} className="font-medium text-primary hover:underline">
                      {r.subject}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {r.type === "DOCUMENT_REQUEST" ? "Document request" : "Question"} from {r.practiceName} · {r.createdAt.slice(0, 10)}
                      {r.dueDate ? ` · due ${r.dueDate}` : ""}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${r.status === "OPEN" ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground"}`}>{STATUS_TEXT[r.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
