import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCurrentPractice, errorParam } from "../../require-practice";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { PracticeRequestService } from "@/domain/practice/practice-request-service";
import { TaskService } from "@/domain/practice/task-service";
import { WorkpaperService } from "@/domain/practice/workpaper-service";
import type { RequestDetail, RequestView } from "@/domain/client-requests/client-request-service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/components/practice/light-badge";
import { closeRequestAction, createRequestAction, replyRequestAction } from "../../actions";

export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: { clientId: string };
  searchParams: { error?: string; notice?: string; request?: string };
}) {
  const { actor, practice } = await requireCurrentPractice();
  const links = await ClientLinkService.list(actor, practice.id);
  const link = links.find((l) => l.clientOrganizationId === params.clientId);
  if (!link) notFound();

  const tasks = await TaskService.list(actor, practice.id, { clientOrganizationId: link.clientOrganizationId, status: "all", limit: 30 });
  const workpapers = await WorkpaperService.list(actor, practice.id, { clientOrganizationId: link.clientOrganizationId });

  // Requests live in the CLIENT's own tenant, read with the staff member's real role there. If that is not
  // possible (not a member, link ended) say exactly why instead of failing.
  let requests: RequestView[] | null = null;
  let requestsProblem: string | null = null;
  let open: RequestDetail | null = null;
  if (link.status === "ACTIVE") {
    try {
      requests = await PracticeRequestService.list(actor, practice.id, link.clientOrganizationId);
      const wanted = searchParams.request ?? requests.find((r) => r.status !== "CLOSED")?.id;
      if (wanted && requests.some((r) => r.id === wanted)) open = await PracticeRequestService.get(actor, practice.id, link.clientOrganizationId, wanted);
    } catch (error) {
      requestsProblem = error instanceof Error ? error.message : "Requests could not be loaded.";
    }
  }
  const error = errorParam(searchParams.error);
  const notice = typeof searchParams.notice === "string" ? searchParams.notice.slice(0, 600) : null;
  const base = `/practice/clients/${link.clientOrganizationId}`;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/practice/clients" className="hover:underline">
            Clients
          </Link>{" "}
          / {link.clientName}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{link.clientName}</h1>
        <p className="text-sm text-muted-foreground">
          Link status: {link.status.toLowerCase()} · Responsible: {link.assignedName ?? "unassigned"}
          {link.status === "ACTIVE" && (
            <>
              {" "}
              ·{" "}
              <Link href={`/${link.clientSlug}`} className="text-primary hover:underline">
                Open the client&apos;s books
              </Link>
            </>
          )}
        </p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {link.status !== "ACTIVE" && (
        <Notice tone="warning">
          This link is not active, so nothing can be read from {link.clientName} and no request can be sent. Your practice keeps its own tasks and workpapers for the client,
          marked as of their snapshot date.
        </Notice>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Queries and document requests</CardTitle>
          <CardDescription>
            Visible to the client in their own &quot;Requests from your accountant&quot; inbox. There is no email or notification system yet — the client sees a request when they open the app.
            Never put internal notes here; practice notes belong on tasks and workpapers, which the client cannot see.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {requestsProblem && <Notice tone="warning">{requestsProblem}</Notice>}
          {requests && (
            <>
              {requests.length === 0 ? (
                <p className="text-sm text-muted-foreground">No requests yet.</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {requests.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                      <Link href={`${base}?request=${r.id}`} className={`hover:underline ${open?.id === r.id ? "font-semibold" : ""}`}>
                        {r.subject}
                      </Link>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {r.type === "DOCUMENT_REQUEST" ? "Document" : "Query"} · {r.status.toLowerCase()}
                        {r.dueDate ? ` · due ${r.dueDate}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {open && (
                <div className="space-y-3 rounded-md border border-border p-4 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{open.subject}</p>
                      <p className="text-xs text-muted-foreground">
                        Raised by {open.requestedByName} on {open.createdAt.slice(0, 10)} · {open.status.toLowerCase()}
                      </p>
                    </div>
                    {open.status !== "CLOSED" && (
                      <form action={closeRequestAction.bind(null, link.clientOrganizationId, open.id)}>
                        <Button type="submit" size="sm" variant="outline">
                          Close request
                        </Button>
                      </form>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap">{open.body}</p>
                  {open.messages.map((m) => (
                    <div key={m.id} className={`rounded-md p-3 ${m.authorSide === "CLIENT" ? "bg-muted" : "border border-border"}`}>
                      <p className="text-xs text-muted-foreground">
                        {m.authorName} ({m.authorSide === "CLIENT" ? "client" : "practice"}) · {m.createdAt.slice(0, 16).replace("T", " ")}
                      </p>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      {m.attachment && (
                        <a
                          className="text-xs text-primary hover:underline"
                          href={`${base}/attachment/${open!.id}/${m.id}`}
                        >
                          Download {m.attachment.fileName} ({Math.ceil(m.attachment.fileSize / 1024)} KB)
                        </a>
                      )}
                    </div>
                  ))}
                  {open.status !== "CLOSED" && (
                    <form action={replyRequestAction.bind(null, link.clientOrganizationId, open.id)} className="space-y-2">
                      <Label htmlFor="reply-body">Reply</Label>
                      <Textarea id="reply-body" name="body" rows={3} />
                      <input type="file" name="file" accept="application/pdf,image/*" aria-label="Attach a document" className="text-xs" />
                      <div>
                        <Button type="submit" size="sm">
                          Send reply
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              )}
              <form action={createRequestAction.bind(null, link.clientOrganizationId)} className="grid gap-3 rounded-md border border-dashed border-border p-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="req-type">Type</Label>
                  <select id="req-type" name="type" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                    <option value="QUERY">Query (a question)</option>
                    <option value="DOCUMENT_REQUEST">Document request</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="req-due">Due date (optional)</Label>
                  <Input id="req-due" name="dueDate" type="date" />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="req-subject">Subject</Label>
                  <Input id="req-subject" name="subject" required maxLength={200} />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="req-body">Message to the client</Label>
                  <Textarea id="req-body" name="body" rows={3} required />
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit" size="sm">
                    Send request
                  </Button>
                </div>
              </form>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workpapers</CardTitle>
        </CardHeader>
        <CardContent>
          {workpapers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None yet.{" "}
              {link.status === "ACTIVE" && (
                <Link className="text-primary hover:underline" href={`/practice/workpapers/new?client=${link.clientOrganizationId}`}>
                  Start one
                </Link>
              )}
            </p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {workpapers.map((w) => (
                <li key={w.id} className="flex items-center justify-between py-2">
                  <Link href={`/practice/workpapers/${w.id}`} className="text-primary hover:underline">
                    {w.accountCode} {w.accountName} — as at {w.periodEnd}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {w.status.replace("_", " ").toLowerCase()} · v{w.version}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Practice tasks for this client</CardTitle>
          <CardDescription>Internal to your practice; the client cannot see them.</CardDescription>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between py-2">
                  <span>{t.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.status.toLowerCase().replace("_", " ")}
                    {t.dueDate ? ` · due ${t.dueDate}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
