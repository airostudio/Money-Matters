import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { ClientRequestNotFoundError, ClientRequestService } from "@/domain/client-requests/client-request-service";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { replyAction } from "../actions";

export default async function RequestPage({ params, searchParams }: { params: { orgSlug: string; requestId: string }; searchParams: { error?: string } }) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);
  if (!roleHasPermission(actor.role, "client_request:read")) notFound();
  const r = await ClientRequestService.get(actor, params.requestId).catch((e) => {
    if (e instanceof ClientRequestNotFoundError) notFound();
    throw e;
  });
  const canRespond = roleHasPermission(actor.role, "client_request:respond") && r.status !== "CLOSED";
  const error = typeof searchParams.error === "string" ? searchParams.error.slice(0, 500) : null;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/requests`} className="hover:underline">
            Requests from your accountant
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{r.subject}</h1>
        <p className="text-sm text-muted-foreground">
          {r.type === "DOCUMENT_REQUEST" ? "Document request" : "Question"} from {r.practiceName} ({r.requestedByName}) · {r.createdAt.slice(0, 10)}
          {r.dueDate ? ` · due ${r.dueDate}` : ""} · {r.status.toLowerCase()}
        </p>
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Card>
        <CardContent className="space-y-4 pt-6 text-sm">
          <p className="whitespace-pre-wrap">{r.body}</p>
          {r.messages.map((m) => (
            <div key={m.id} className={`rounded-md p-3 ${m.authorSide === "CLIENT" ? "bg-muted" : "border border-border"}`}>
              <p className="text-xs text-muted-foreground">
                {m.authorName} ({m.authorSide === "CLIENT" ? "you / your team" : "your accountant"}) · {m.createdAt.slice(0, 16).replace("T", " ")}
              </p>
              <p className="whitespace-pre-wrap">{m.body}</p>
              {m.attachment && (
                <a className="text-xs text-primary hover:underline" href={`/${org.slug}/requests/${r.id}/attachment/${m.id}`}>
                  Download {m.attachment.fileName} ({Math.ceil(m.attachment.fileSize / 1024)} KB)
                </a>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
      {canRespond ? (
        <Card>
          <CardContent className="pt-6">
            <form action={replyAction.bind(null, org.slug, r.id)} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="body">Your reply</Label>
                <Textarea id="body" name="body" rows={4} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="file">Attach a document (PDF or image, up to 10 MB)</Label>
                <input id="file" type="file" name="file" accept="application/pdf,image/*" className="block text-sm" />
              </div>
              <Button type="submit">Send reply</Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">{r.status === "CLOSED" ? "This request is closed." : "Your role can read this request but not reply to it."}</p>
      )}
    </div>
  );
}
