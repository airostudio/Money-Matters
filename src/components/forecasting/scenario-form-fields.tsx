import type { ScenarioType } from "@/domain/forecasting/scenario-parameters";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ScenarioFormOptions {
  customers: Array<{ customerContactId: string; name: string; revenue: string }>;
  products: Array<{ id: string; name: string }>;
  revenueAccounts: Array<{ id: string; code: string; name: string }>;
  budgets: Array<{ id: string; name: string }>;
  /** Phase 8's verified SG rate — a SUGGESTION pre-filled for a new hire's on-cost, never applied silently. */
  suggestedOnCost: { percent: string; source: string } | null;
}

type Values = Record<string, string | string[]>;

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const SELECT = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

function str(values: Values, name: string, fallback = ""): string {
  const v = values[name];
  return Array.isArray(v) ? fallback : (v ?? fallback);
}

function Baseline({ values, budgets }: { values: Values; budgets: ScenarioFormOptions["budgets"] }) {
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-4">
      <legend className="px-1 text-sm font-medium">Baseline (the unmodified comparison)</legend>
      <Field id="baselineSource" label="Start from" hint="Where the monthly revenue and expense run-rate comes from.">
        <select id="baselineSource" name="baselineSource" defaultValue={str(values, "baselineSource", "ACTUALS")} className={SELECT}>
          <option value="ACTUALS">Trailing actuals (average of recent full months)</option>
          <option value="BUDGET">An active baseline budget</option>
        </select>
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="trailingMonths" label="Trailing months (actuals)" hint="1–12. Default 3.">
          <Input id="trailingMonths" name="trailingMonths" type="number" min={1} max={12} defaultValue={str(values, "trailingMonths", "3")} />
        </Field>
        <Field id="budgetId" label="Budget (budget baseline)" hint="Blank = the active baseline budget covering the projection.">
          <select id="budgetId" name="budgetId" defaultValue={str(values, "budgetId")} className={SELECT}>
            <option value="">Active baseline budget</option>
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </fieldset>
  );
}

/**
 * The typed parameter form for one scenario type. Every ASSUMPTION is a
 * labelled input with its default stated beside it — nothing hidden. Field
 * names line up with `scenarioParamsFromForm`.
 */
export function ScenarioFormFields({ type, values, options }: { type: ScenarioType; values: Values; options: ScenarioFormOptions }) {
  const selected = (name: string) => (Array.isArray(values[name]) ? (values[name] as string[]) : []);

  return (
    <div className="space-y-5">
      {type === "HIRE_EMPLOYEE" && (
        <>
          <fieldset className="space-y-3 rounded-md border border-border p-4">
            <legend className="px-1 text-sm font-medium">The hire</legend>
            <Field id="roleTitle" label="Role (optional)">
              <Input id="roleTitle" name="roleTitle" defaultValue={str(values, "roleTitle")} placeholder="Sales executive" />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field id="annualSalary" label="Annual salary" hint="Base currency.">
                <Input id="annualSalary" name="annualSalary" inputMode="decimal" required defaultValue={str(values, "annualSalary")} />
              </Field>
              <Field
                id="onCostPercent"
                label="On-costs (% of salary)"
                hint={
                  options.suggestedOnCost
                    ? `Suggested ${options.suggestedOnCost.percent}% — ${options.suggestedOnCost.source}. It's only a suggestion: add payroll tax, workers' comp, leave loading as you see fit.`
                    : "Super plus any other on-costs. No default is assumed."
                }
              >
                <Input
                  id="onCostPercent"
                  name="onCostPercent"
                  inputMode="decimal"
                  required
                  defaultValue={str(values, "onCostPercent", options.suggestedOnCost?.percent ?? "")}
                />
              </Field>
              <Field id="startDate" label="Start date">
                <Input id="startDate" name="startDate" type="date" required defaultValue={str(values, "startDate")} />
              </Field>
            </div>
          </fieldset>
          <fieldset className="space-y-3 rounded-md border border-border p-4">
            <legend className="px-1 text-sm font-medium">Expected productivity (assumptions)</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field id="incrementalMonthlyRevenue" label="Extra revenue per month" hint="At full productivity. Default 0 — a pure cost.">
                <Input id="incrementalMonthlyRevenue" name="incrementalMonthlyRevenue" inputMode="decimal" defaultValue={str(values, "incrementalMonthlyRevenue", "0")} />
              </Field>
              <Field id="rampMonths" label="Ramp-up (months)" hint="Linear from the start month. Default 0 = full from day one.">
                <Input id="rampMonths" name="rampMonths" type="number" min={0} max={24} defaultValue={str(values, "rampMonths", "0")} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="bestRevenuePercentOfExpected" label="Best case: revenue realised (%)" hint="Of the stated extra revenue. Default 125.">
                <Input id="bestRevenuePercentOfExpected" name="bestRevenuePercentOfExpected" inputMode="decimal" defaultValue={str(values, "bestRevenuePercentOfExpected", "125")} />
              </Field>
              <Field id="worstRevenuePercentOfExpected" label="Worst case: revenue realised (%)" hint="Default 0 — no revenue at all.">
                <Input id="worstRevenuePercentOfExpected" name="worstRevenuePercentOfExpected" inputMode="decimal" defaultValue={str(values, "worstRevenuePercentOfExpected", "0")} />
              </Field>
            </div>
          </fieldset>
        </>
      )}

      {type === "PRICE_CHANGE" && (
        <>
          <fieldset className="space-y-3 rounded-md border border-border p-4">
            <legend className="px-1 text-sm font-medium">The price change</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="priceChangePercent" label="Price change (%)" hint="Positive = increase, negative = decrease. e.g. 8">
                <Input id="priceChangePercent" name="priceChangePercent" inputMode="decimal" required defaultValue={str(values, "priceChangePercent")} />
              </Field>
              <Field id="effectiveDate" label="Effective date">
                <Input id="effectiveDate" name="effectiveDate" type="date" required defaultValue={str(values, "effectiveDate")} />
              </Field>
            </div>
            <Field id="scopeKind" label="Applies to">
              <select id="scopeKind" name="scopeKind" defaultValue={str(values, "scopeKind", "ALL")} className={SELECT}>
                <option value="ALL">All revenue</option>
                <option value="CUSTOMERS">Selected customers</option>
                <option value="PRODUCTS">Selected products</option>
                <option value="REVENUE_ACCOUNTS">Selected revenue accounts</option>
              </select>
            </Field>
            <p className="text-xs text-muted-foreground">Pick the items below only if you chose a selected scope above; they are ignored for &quot;All revenue&quot;.</p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Customers (by trailing-12-month revenue)</p>
                <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-border p-2 text-sm">
                  {options.customers.length === 0 && <p className="text-muted-foreground">No invoiced customers yet.</p>}
                  {options.customers.map((c) => (
                    <label key={c.customerContactId} className="flex items-center gap-2">
                      <input type="checkbox" name="customerContactIds" value={c.customerContactId} defaultChecked={selected("customerContactIds").includes(c.customerContactId)} />
                      {c.name} <span className="text-xs text-muted-foreground">({c.revenue})</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Products</p>
                <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-border p-2 text-sm">
                  {options.products.length === 0 && <p className="text-muted-foreground">No products.</p>}
                  {options.products.map((p) => (
                    <label key={p.id} className="flex items-center gap-2">
                      <input type="checkbox" name="productIds" value={p.id} defaultChecked={selected("productIds").includes(p.id)} />
                      {p.name}
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Revenue accounts</p>
                <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-border p-2 text-sm">
                  {options.revenueAccounts.map((a) => (
                    <label key={a.id} className="flex items-center gap-2">
                      <input type="checkbox" name="accountIds" value={a.id} defaultChecked={selected("accountIds").includes(a.id)} />
                      {a.code} {a.name}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </fieldset>
          <fieldset className="space-y-3 rounded-md border border-border p-4">
            <legend className="px-1 text-sm font-medium">Volume response (your assumption)</legend>
            <p className="text-xs text-muted-foreground">
              This feature does not estimate how your customers respond to price from history — there isn&apos;t enough data to do that honestly — so the volume change you
              assume for each case is an explicit input. Negative = volume lost. Best ≥ expected ≥ worst.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field id="volumeBest" label="Best case volume change (%)" hint="Default 0.">
                <Input id="volumeBest" name="volumeBest" inputMode="decimal" defaultValue={str(values, "volumeBest", "0")} />
              </Field>
              <Field id="volumeExpected" label="Expected case volume change (%)" hint="Default 0 — no volume loss.">
                <Input id="volumeExpected" name="volumeExpected" inputMode="decimal" defaultValue={str(values, "volumeExpected", "0")} />
              </Field>
              <Field id="volumeWorst" label="Worst case volume change (%)" hint="Default −5.">
                <Input id="volumeWorst" name="volumeWorst" inputMode="decimal" defaultValue={str(values, "volumeWorst", "-5")} />
              </Field>
            </div>
            <Field id="variableCostPercentOverride" label="Avoidable cost on lost volume (%) — optional" hint="Blank = derived from cost of sales on your tracked-inventory sales in scope (0 if none).">
              <Input id="variableCostPercentOverride" name="variableCostPercentOverride" inputMode="decimal" defaultValue={str(values, "variableCostPercentOverride")} className="w-48" />
            </Field>
          </fieldset>
        </>
      )}

      {type === "LOSE_CUSTOMER" && (
        <>
          <fieldset className="space-y-3 rounded-md border border-border p-4">
            <legend className="px-1 text-sm font-medium">The loss</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="customerContactId" label="Customer" hint="Default: your largest customer by trailing-12-month invoiced revenue.">
                <select id="customerContactId" name="customerContactId" defaultValue={str(values, "customerContactId")} className={SELECT}>
                  <option value="">{options.customers[0] ? `Largest customer (currently ${options.customers[0].name})` : "Largest customer"}</option>
                  {options.customers.map((c) => (
                    <option key={c.customerContactId} value={c.customerContactId}>
                      {c.name} ({c.revenue})
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="effectiveDate" label="Lost from">
                <Input id="effectiveDate" name="effectiveDate" type="date" required defaultValue={str(values, "effectiveDate")} />
              </Field>
            </div>
            <Field
              id="avoidedCostPercentOverride"
              label="Cost avoided when their revenue goes (%) — optional"
              hint="Blank = the cost of sales attributable to this customer's tracked-inventory sales; if none exists the result is revenue-only and says so."
            >
              <Input id="avoidedCostPercentOverride" name="avoidedCostPercentOverride" inputMode="decimal" defaultValue={str(values, "avoidedCostPercentOverride")} className="w-48" />
            </Field>
          </fieldset>
          <fieldset className="space-y-3 rounded-md border border-border p-4">
            <legend className="px-1 text-sm font-medium">Case spreads (your assumptions)</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field id="bestReplacementPercent" label="Best case: revenue replaced (%)" hint="Default 50.">
                <Input id="bestReplacementPercent" name="bestReplacementPercent" inputMode="decimal" defaultValue={str(values, "bestReplacementPercent", "50")} />
              </Field>
              <Field id="bestReplacementLagMonths" label="…starting after (months)" hint="Default 3.">
                <Input id="bestReplacementLagMonths" name="bestReplacementLagMonths" type="number" min={0} max={24} defaultValue={str(values, "bestReplacementLagMonths", "3")} />
              </Field>
              <Field id="worstCollectionDelayMonths" label="Worst case: open receivables late by (months)" hint="Default 2.">
                <Input id="worstCollectionDelayMonths" name="worstCollectionDelayMonths" type="number" min={0} max={12} defaultValue={str(values, "worstCollectionDelayMonths", "2")} />
              </Field>
            </div>
          </fieldset>
        </>
      )}

      <Baseline values={values} budgets={options.budgets} />
    </div>
  );
}
