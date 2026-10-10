import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import {
  REPORT_ACCOUNT_TYPES,
  ReportBuilderService,
  type ReportBuilderConfig,
  type ReportBuilderResult,
} from "@/domain/reporting/report-builder-service";
import { DimensionService } from "@/domain/dimensions/dimension-service";
import { currentMonthRange, formatDateParam } from "@/domain/reporting/period-presets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DimensionFilterField } from "@/components/accounting/dimension-filter-field";
import { ReportResultTable } from "@/components/accounting/report-result-table";
import { saveReportAction, deleteSavedReportAction } from "./actions";

interface BuilderSearchParams {
  rowGroupBy?: string;
  /** Next.js gives an array when the GET form submits more than one `accountTypes` checkbox, a plain string for exactly one, and `undefined` for none. */
  accountTypes?: string | string[];
  measure?: string;
  periodBreakdown?: string;
  dateFrom?: string;
  dateTo?: string;
  dimension?: string;
  compare?: string;
  zero?: string;
  saved?: string;
  error?: string;
}

function configFromSearchParams(sp: BuilderSearchParams): ReportBuilderConfig {
  const defaultRange = currentMonthRange();
  const rawTypes = sp.accountTypes === undefined ? [] : Array.isArray(sp.accountTypes) ? sp.accountTypes : [sp.accountTypes];
  const accountTypes = rawTypes.filter((t): t is ReportBuilderConfig["accountTypes"][number] =>
    (REPORT_ACCOUNT_TYPES as readonly string[]).includes(t),
  ) as ReportBuilderConfig["accountTypes"];

  return {
    rowGroupBy: sp.rowGroupBy === "ACCOUNT_TYPE" ? "ACCOUNT_TYPE" : "ACCOUNT",
    accountTypes: accountTypes.length > 0 ? accountTypes : ["REVENUE", "EXPENSE"],
    measure: sp.measure === "BALANCE" ? "BALANCE" : "MOVEMENT",
    periodBreakdown: sp.periodBreakdown === "MONTHLY" || sp.periodBreakdown === "QUARTERLY" ? sp.periodBreakdown : "NONE",
    dateFrom: sp.dateFrom ?? formatDateParam(defaultRange.from),
    dateTo: sp.dateTo ?? formatDateParam(defaultRange.to),
    dimensionValueId: sp.dimension?.trim() || undefined,
    includeComparisonPeriod: sp.compare === "1",
    includeZeroRows: sp.zero === "1",
  };
}

export default async function ReportBuilderPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: BuilderSearchParams;
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const canSave = roleHasPermission(actor.role, "saved_report:manage");

  const savedReportId = searchParams.saved;
  const config = savedReportId
    ? ((await ReportBuilderService.getSavedReport(actor, savedReportId))?.config ?? configFromSearchParams(searchParams))
    : configFromSearchParams(searchParams);

  const [result, dimensions, savedReports] = await Promise.all([
    ReportBuilderService.runConfig(actor, config).catch((): ReportBuilderResult | null => null),
    DimensionService.listActive(actor),
    ReportBuilderService.listSavedReports(actor),
  ]);

  const configJson = JSON.stringify(config);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Report Builder</h1>
        <p className="text-sm text-muted-foreground">
          Compose a report from rows, columns, a measure, filters, and an optional comparison period (master spec §33).
          Save a configuration to re-run it later with fresh data — it is never a cached snapshot.
        </p>
      </div>

      {searchParams.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
        </CardHeader>
        <form method="get">
          <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="rowGroupBy" className="text-xs">
                Rows
              </Label>
              <select
                id="rowGroupBy"
                name="rowGroupBy"
                defaultValue={config.rowGroupBy}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="ACCOUNT">Individual accounts</option>
                <option value="ACCOUNT_TYPE">Account type totals</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="measure" className="text-xs">
                Measure
              </Label>
              <select
                id="measure"
                name="measure"
                defaultValue={config.measure}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="MOVEMENT">Movement (activity in period)</option>
                <option value="BALANCE">Balance (as of column end)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="periodBreakdown" className="text-xs">
                Columns
              </Label>
              <select
                id="periodBreakdown"
                name="periodBreakdown"
                defaultValue={config.periodBreakdown}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="NONE">Single column</option>
                <option value="MONTHLY">Monthly</option>
                <option value="QUARTERLY">Quarterly</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="dateFrom" className="text-xs">
                From
              </Label>
              <Input type="date" id="dateFrom" name="dateFrom" defaultValue={config.dateFrom} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dateTo" className="text-xs">
                To
              </Label>
              <Input type="date" id="dateTo" name="dateTo" defaultValue={config.dateTo} />
            </div>
            <DimensionFilterField dimensions={dimensions} selectedValueId={config.dimensionValueId} />
            <div className="col-span-2 space-y-2 sm:col-span-3">
              <Label className="text-xs">Account types</Label>
              <div className="flex flex-wrap gap-3">
                {REPORT_ACCOUNT_TYPES.map((type) => (
                  <label key={type} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      name="accountTypes"
                      value={type}
                      defaultChecked={config.accountTypes.includes(type)}
                    />
                    {type.charAt(0) + type.slice(1).toLowerCase()}
                  </label>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" name="compare" value="1" defaultChecked={config.includeComparisonPeriod} />
              Compare to prior period
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" name="zero" value="1" defaultChecked={config.includeZeroRows} />
              Include zero rows
            </label>
          </CardContent>
          <div className="flex justify-end border-t border-border px-6 py-4">
            <Button type="submit">Run report</Button>
          </div>
        </form>
      </Card>

      {canSave && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Save this report</CardTitle>
          </CardHeader>
          <form action={saveReportAction.bind(null, org.slug)}>
            <input type="hidden" name="config" value={configJson} />
            <CardContent className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="name" className="text-xs">
                  Name
                </Label>
                <Input id="name" name="name" placeholder="Monthly revenue by account" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="visibility" className="text-xs">
                  Visibility
                </Label>
                <select
                  id="visibility"
                  name="visibility"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="PERSONAL">Only me</option>
                  <option value="ORGANIZATION">Everyone in the organization</option>
                </select>
              </div>
              <div className="col-span-2 space-y-1">
                <Label htmlFor="description" className="text-xs">
                  Description (optional)
                </Label>
                <Input id="description" name="description" placeholder="What this report is for" />
              </div>
            </CardContent>
            <div className="flex justify-end border-t border-border px-6 py-4">
              <Button type="submit" variant="outline">
                Save
              </Button>
            </div>
          </form>
        </Card>
      )}

      {savedReports.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Saved reports</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {savedReports.map((r) => (
                <li key={r.id} className="flex items-center justify-between px-6 py-3 text-sm">
                  <div>
                    <a href={`/${org.slug}/accounting/reports/builder?saved=${r.id}`} className="text-primary hover:underline">
                      {r.name}
                    </a>
                    <p className="text-xs text-muted-foreground">
                      {r.visibility === "ORGANIZATION" ? "Shared with organization" : "Personal"}
                      {r.description ? ` — ${r.description}` : ""}
                    </p>
                  </div>
                  {r.mine && (
                    <form action={deleteSavedReportAction.bind(null, org.slug, r.id)}>
                      <Button type="submit" variant="ghost" size="sm">
                        Delete
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <ReportResultTable result={result} />
    </div>
  );
}
