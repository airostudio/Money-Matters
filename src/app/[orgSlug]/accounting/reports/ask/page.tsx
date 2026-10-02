import { requireOrgAndActor } from "@/lib/session";
import { NLReportingService } from "@/domain/reporting/nl-reporting-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ReportResultTable } from "@/components/accounting/report-result-table";

const EXAMPLE_QUESTIONS = [
  "What was our revenue last quarter?",
  "Show expenses by month for the last 6 months",
  "What are our total assets this year compared to last year?",
];

/**
 * Master spec §34's Natural-Language Reporting front door. A GET form (not a
 * client component) so the question survives a page reload/bookmark like
 * every other report page in this codebase — `NLReportingService.ask` does
 * the AI interpretation step server-side on each request. See that
 * service's doc comment, and docs/ai-agents.md, for the full "classify,
 * never compute" pipeline this page is the UI for.
 */
export default async function AskReportPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { q?: string };
}) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  const question = searchParams.q?.trim();
  const outcome = question ? await NLReportingService.ask(actor, question) : undefined;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Ask a question</h1>
        <p className="text-sm text-muted-foreground">
          Ask a plain-English question about your financials. Claude translates it into a structured report request —
          it never calculates the answer itself; the same deterministic engine behind the Report Builder does.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form method="get" className="flex gap-2">
            <input
              type="text"
              name="q"
              defaultValue={question}
              placeholder="e.g. What was our revenue last quarter?"
              className="h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm"
            />
            <Button type="submit">Ask</Button>
          </form>
          {!question && (
            <div className="mt-3 flex flex-wrap gap-2">
              {EXAMPLE_QUESTIONS.map((example) => (
                <a
                  key={example}
                  href={`?q=${encodeURIComponent(example)}`}
                  className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                >
                  {example}
                </a>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {outcome?.status === "unavailable" && (
        <Card>
          <CardContent className="space-y-2 pt-6 text-sm">
            <p className="text-muted-foreground">{outcome.reason}</p>
            <p>
              Try the{" "}
              <a href={`/${params.orgSlug}/accounting/reports/builder`} className="text-primary hover:underline">
                Report Builder
              </a>{" "}
              instead.
            </p>
          </CardContent>
        </Card>
      )}

      {outcome?.status === "clarification_needed" && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">{outcome.message}</CardContent>
        </Card>
      )}

      {outcome?.status === "ok" && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">{outcome.restatement}</CardTitle>
            </CardHeader>
          </Card>
          <ReportResultTable result={outcome.result} />
        </>
      )}
    </div>
  );
}
