"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Bot, Check, ChevronDown, Loader2, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  DEFAULT_BANK_ACCOUNT_CODE,
  TEMPLATE_LABELS,
  type AccountGroup,
  type ClassificationFlags,
  type TemplateAccount,
  type TemplateKey,
} from "@/domain/onboarding/chart-of-accounts-templates";
import { applyChartOfAccountsAction, getRecommendationAction, type RecommendationResult } from "./actions";

const COUNTRIES = [
  { code: "AU", name: "Australia", currency: "AUD" },
  { code: "NZ", name: "New Zealand", currency: "NZD" },
  { code: "US", name: "United States", currency: "USD" },
  { code: "GB", name: "United Kingdom", currency: "GBP" },
  { code: "CA", name: "Canada", currency: "CAD" },
];

const GROUP_ORDER: AccountGroup[] = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];
const GROUP_LABELS: Record<AccountGroup, string> = {
  ASSET: "Assets",
  LIABILITY: "Liabilities",
  EQUITY: "Equity",
  REVENUE: "Revenue",
  EXPENSE: "Expenses",
};

type StepId = "basics" | "chart" | "bank" | "done";
const STEPS: Array<{ id: StepId; label: string }> = [
  { id: "basics", label: "Business basics" },
  { id: "chart", label: "Chart of accounts" },
  { id: "bank", label: "Bank account" },
  { id: "done", label: "Done" },
];

interface Props {
  orgSlug: string;
  organizationName: string;
  defaultCountry: string;
  defaultCurrency: string;
  hasExistingChartOfAccounts: boolean;
  existingAssetAccounts: Array<{ id: string; code: string; name: string }>;
  createBankAccountAction: (formData: FormData) => Promise<void>;
  initialBankError?: string;
}

/** Fades/slides new step content in — the only "animation library" this design system needs. */
function StepTransition({ stepKey, children }: { stepKey: string; children: ReactNode }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    setEntered(false);
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [stepKey]);
  return (
    <div
      className={cn(
        "transition-all duration-300 ease-out",
        entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
    >
      {children}
    </div>
  );
}

function ProgressBar({ currentIndex }: { currentIndex: number }) {
  return (
    <ol className="mb-8 flex items-center gap-2">
      {STEPS.map((step, index) => {
        const isDone = index < currentIndex;
        const isCurrent = index === currentIndex;
        return (
          <li key={step.id} className="flex flex-1 items-center gap-2">
            <div
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                isDone && "border-primary bg-primary text-primary-foreground",
                isCurrent && !isDone && "border-primary text-primary",
                !isDone && !isCurrent && "border-border text-muted-foreground",
              )}
            >
              {isDone ? <Check className="size-4" /> : index + 1}
            </div>
            <span
              className={cn(
                "hidden text-sm sm:inline",
                isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {step.label}
            </span>
            {index < STEPS.length - 1 && (
              <div className={cn("h-px flex-1", isDone ? "bg-primary" : "bg-border")} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function OnboardingWizard({
  orgSlug,
  organizationName,
  defaultCountry,
  defaultCurrency,
  hasExistingChartOfAccounts,
  existingAssetAccounts,
  createBankAccountAction,
  initialBankError,
}: Props) {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(initialBankError ? 2 : 0);
  const [bankError, setBankError] = useState<string | undefined>(initialBankError);

  // Step 1 state
  const [businessName, setBusinessName] = useState(organizationName);
  const [description, setDescription] = useState("");
  const [country, setCountry] = useState(defaultCountry || "AU");
  const [currency, setCurrency] = useState(defaultCurrency || "AUD");
  const [basicsError, setBasicsError] = useState<string | null>(null);

  // Step 2 state
  const [loadingRecommendation, setLoadingRecommendation] = useState(false);
  const [recommendationResult, setRecommendationResult] = useState<RecommendationResult | null>(null);
  const [editedAccounts, setEditedAccounts] = useState<TemplateAccount[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<AccountGroup>>(new Set());
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [createdCount, setCreatedCount] = useState<number | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const [newAccount, setNewAccount] = useState<{ code: string; name: string; type: TemplateAccount["type"] }>({
    code: "",
    name: "",
    type: "EXPENSE",
  });

  const [skippingBank, setSkippingBank] = useState(false);
  const [assetAccounts, setAssetAccounts] = useState(existingAssetAccounts);

  const totalProposed = editedAccounts.length;
  const groups = useMemo(() => {
    const out: Record<AccountGroup, TemplateAccount[]> = {
      ASSET: [],
      LIABILITY: [],
      EQUITY: [],
      REVENUE: [],
      EXPENSE: [],
    };
    for (const account of editedAccounts) out[account.type].push(account);
    return out;
  }, [editedAccounts]);

  function toggleGroup(group: AccountGroup) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  function removeAccount(code: string) {
    setEditedAccounts((prev) => prev.filter((a) => a.code !== code));
  }

  function addAccount() {
    if (!newAccount.code.trim() || !newAccount.name.trim()) return;
    if (editedAccounts.some((a) => a.code === newAccount.code.trim())) return;
    setEditedAccounts((prev) => [...prev, { code: newAccount.code.trim(), name: newAccount.name.trim(), type: newAccount.type }]);
    setNewAccount({ code: "", name: "", type: "EXPENSE" });
    setAddingAccount(false);
  }

  async function handleBasicsSubmit() {
    setBasicsError(null);
    if (!description.trim()) {
      setBasicsError("Tell us a little about your business — a sentence or two is enough.");
      return;
    }
    setStepIndex(1);
    setLoadingRecommendation(true);
    try {
      const result = await getRecommendationAction(orgSlug, { description, country });
      setRecommendationResult(result);
      setEditedAccounts(result.proposedAccounts);
    } catch {
      setBasicsError("Something went wrong preparing your chart of accounts. Please try again.");
      setStepIndex(0);
    } finally {
      setLoadingRecommendation(false);
    }
  }

  async function handleConfirmChart() {
    if (!recommendationResult) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyChartOfAccountsAction(orgSlug, {
        templateKey: recommendationResult.recommendation.templateKey,
        flags: recommendationResult.recommendation.flags,
        accounts: editedAccounts,
        recommendation: {
          source: recommendationResult.recommendation.source,
          model: recommendationResult.recommendation.model,
          confidence: recommendationResult.recommendation.confidence,
          reasoning: recommendationResult.recommendation.reasoning,
        },
      });
      setCreatedCount(result.createdCount);
      setAssetAccounts((prev) => {
        const byCode = new Map(prev.map((a) => [a.code, a] as const));
        for (const created of result.createdAssetAccounts) {
          byCode.set(created.code, created);
        }
        return [...byCode.values()];
      });
      setStepIndex(2);
      router.refresh();
    } catch {
      setApplyError("Couldn't save your chart of accounts. Please try again.");
    } finally {
      setApplying(false);
    }
  }

  const defaultAssetAccountId =
    assetAccounts.find((a) => a.code === DEFAULT_BANK_ACCOUNT_CODE)?.id ?? assetAccounts[0]?.id;

  const bankFormRef = useRef<HTMLFormElement>(null);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Set up {organizationName}</h1>
        <p className="text-sm text-muted-foreground">
          A few quick steps and you&apos;ll have a real chart of accounts and your first bank account linked.
        </p>
      </div>

      <ProgressBar currentIndex={stepIndex} />

      {stepIndex === 0 && (
        <StepTransition stepKey="basics">
          <Card>
            <CardHeader>
              <CardTitle>Tell us about your business</CardTitle>
              <CardDescription>
                This helps us recommend a chart of accounts that fits — you can edit anything before it&apos;s created.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {hasExistingChartOfAccounts && (
                <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">
                  This organization already has some accounts. Running this again will only add accounts that
                  don&apos;t already exist — nothing will be duplicated or removed.
                </p>
              )}
              {basicsError && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{basicsError}</p>
              )}
              <div className="space-y-2">
                <Label htmlFor="businessName">Business name</Label>
                <Input id="businessName" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Tell us about your business</Label>
                <Textarea
                  id="description"
                  placeholder="e.g. We're an electrical contracting company in Melbourne with 5 employees"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={2000}
                />
                <p className="text-xs text-muted-foreground">{description.length}/2000</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="country">Country</Label>
                  <select
                    id="country"
                    value={country}
                    onChange={(e) => {
                      setCountry(e.target.value);
                      const match = COUNTRIES.find((c) => c.code === e.target.value);
                      if (match) setCurrency(match.currency);
                    }}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="currency">Base currency</Label>
                  <Input id="currency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
                </div>
              </div>
            </CardContent>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              <Button onClick={handleBasicsSubmit}>Continue</Button>
            </div>
          </Card>
        </StepTransition>
      )}

      {stepIndex === 1 && (
        <StepTransition stepKey="chart">
          {loadingRecommendation ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <Loader2 className="size-8 animate-spin text-primary" />
                <p className="text-sm font-medium">Putting together a chart of accounts for you…</p>
                <p className="text-xs text-muted-foreground">This only takes a moment.</p>
              </CardContent>
            </Card>
          ) : recommendationResult ? (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    {recommendationResult.recommendation.source === "AI" ? (
                      <Bot className="size-4 text-primary" />
                    ) : (
                      <Sparkles className="size-4 text-primary" />
                    )}
                    Recommended: {TEMPLATE_LABELS[recommendationResult.recommendation.templateKey as TemplateKey]}
                  </CardTitle>
                  <CardDescription>
                    {recommendationResult.recommendation.source === "AI"
                      ? "Suggested by our AI assistant, based on what you told us."
                      : "Using our standard template for your industry."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="text-muted-foreground">{recommendationResult.recommendation.reasoning}</p>
                  <FlagSummary flags={recommendationResult.recommendation.flags} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle className="text-base">Proposed chart of accounts</CardTitle>
                    <CardDescription>
                      {totalProposed} account{totalProposed === 1 ? "" : "s"} will be created. Remove anything you
                      don&apos;t need, or add your own below.
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {applyError && (
                    <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{applyError}</p>
                  )}
                  {GROUP_ORDER.map((group) => (
                    <div key={group} className="rounded-md border border-border">
                      <button
                        type="button"
                        onClick={() => toggleGroup(group)}
                        className="flex w-full items-center justify-between px-4 py-2 text-left text-sm font-medium hover:bg-accent/50"
                      >
                        <span>
                          {GROUP_LABELS[group]}{" "}
                          <span className="text-muted-foreground">({groups[group].length})</span>
                        </span>
                        <ChevronDown
                          className={cn("size-4 transition-transform", collapsedGroups.has(group) && "-rotate-90")}
                        />
                      </button>
                      {!collapsedGroups.has(group) && groups[group].length > 0 && (
                        <ul className="divide-y divide-border border-t border-border">
                          {groups[group].map((account) => (
                            <li key={account.code} className="flex items-center justify-between px-4 py-2 text-sm">
                              <div className="min-w-0">
                                <span className="font-mono text-xs text-muted-foreground">{account.code}</span>{" "}
                                <span className="font-medium">{account.name}</span>
                                {account.subType && (
                                  <span className="ml-2 text-xs text-muted-foreground">{account.subType}</span>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => removeAccount(account.code)}
                                aria-label={`Remove ${account.name}`}
                                className="text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="size-4" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}

                  {addingAccount ? (
                    <div className="grid grid-cols-4 gap-2 rounded-md border border-dashed border-border p-3">
                      <Input
                        placeholder="Code"
                        value={newAccount.code}
                        onChange={(e) => setNewAccount((a) => ({ ...a, code: e.target.value }))}
                      />
                      <Input
                        placeholder="Name"
                        className="col-span-2"
                        value={newAccount.name}
                        onChange={(e) => setNewAccount((a) => ({ ...a, name: e.target.value }))}
                      />
                      <select
                        value={newAccount.type}
                        onChange={(e) =>
                          setNewAccount((a) => ({ ...a, type: e.target.value as TemplateAccount["type"] }))
                        }
                        className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      >
                        {GROUP_ORDER.map((g) => (
                          <option key={g} value={g}>
                            {GROUP_LABELS[g]}
                          </option>
                        ))}
                      </select>
                      <div className="col-span-4 flex justify-end gap-2">
                        <Button type="button" variant="ghost" size="sm" onClick={() => setAddingAccount(false)}>
                          Cancel
                        </Button>
                        <Button type="button" size="sm" onClick={addAccount}>
                          Add account
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button type="button" variant="outline" size="sm" onClick={() => setAddingAccount(true)}>
                      + Add a custom account
                    </Button>
                  )}
                </CardContent>
                <div className="flex justify-between gap-2 border-t border-border px-6 py-4">
                  <Button variant="ghost" onClick={() => setStepIndex(0)} disabled={applying}>
                    Back
                  </Button>
                  <Button onClick={handleConfirmChart} disabled={applying || totalProposed === 0}>
                    {applying ? (
                      <>
                        <Loader2 className="size-4 animate-spin" /> Creating accounts…
                      </>
                    ) : (
                      `Create ${totalProposed} account${totalProposed === 1 ? "" : "s"}`
                    )}
                  </Button>
                </div>
              </Card>
            </div>
          ) : null}
        </StepTransition>
      )}

      {stepIndex === 2 && (
        <StepTransition stepKey="bank">
          <Card>
            <CardHeader>
              <CardTitle>Link your first bank account</CardTitle>
              <CardDescription>
                {createdCount !== null && createdCount > 0
                  ? `${createdCount} account${createdCount === 1 ? "" : "s"} created. `
                  : ""}
                Every reconciled transaction will post against the ledger account you choose here.
              </CardDescription>
            </CardHeader>
            <form
              ref={bankFormRef}
              action={async (formData) => {
                setBankError(undefined);
                await createBankAccountAction(formData);
              }}
            >
              <CardContent className="space-y-4">
                {bankError && (
                  <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{bankError}</p>
                )}
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" placeholder="Everyday Account" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="glAccountId">Ledger account</Label>
                  {assetAccounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No ASSET accounts exist yet — go back and keep at least one in your chart of accounts, or add
                      one later from Chart of Accounts.
                    </p>
                  ) : (
                    <select
                      id="glAccountId"
                      name="glAccountId"
                      required
                      defaultValue={defaultAssetAccountId}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {assetAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} — {account.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="institutionName">Institution (optional)</Label>
                    <Input id="institutionName" name="institutionName" placeholder="Commonwealth Bank" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="accountNumberLast4">Last 4 digits (optional)</Label>
                    <Input id="accountNumberLast4" name="accountNumberLast4" maxLength={4} placeholder="1234" />
                  </div>
                </div>
                <input type="hidden" name="currency" value={currency} />
              </CardContent>
              <div className="flex justify-between gap-2 border-t border-border px-6 py-4">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={skippingBank}
                  onClick={() => {
                    setSkippingBank(true);
                    setStepIndex(3);
                  }}
                >
                  Skip for now
                </Button>
                <Button type="submit" disabled={assetAccounts.length === 0}>
                  Link account
                </Button>
              </div>
            </form>
          </Card>
        </StepTransition>
      )}

      {stepIndex === 3 && (
        <StepTransition stepKey="done">
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
              <div className="flex size-14 items-center justify-center rounded-full bg-success/10">
                <Check className="size-7 text-success" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">You&apos;re all set up</h2>
                <p className="text-sm text-muted-foreground">
                  Your chart of accounts is ready{skippingBank ? "" : " and your first bank account is linked"}. You
                  can always fine-tune accounts in Chart of Accounts, or add more bank accounts from Money.
                </p>
              </div>
              <Button onClick={() => router.push(`/${orgSlug}`)}>Go to dashboard</Button>
            </CardContent>
          </Card>
        </StepTransition>
      )}
    </div>
  );
}

function FlagSummary({ flags }: { flags: ClassificationFlags }) {
  const items: Array<{ label: string; on: boolean }> = [
    { label: "Sells goods", on: flags.sellsGoods },
    { label: "Sells services", on: flags.sellsServices },
    { label: "Has employees", on: flags.hasEmployees },
    { label: "Tracks inventory", on: flags.tracksInventory },
  ];
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {items
        .filter((i) => i.on)
        .map((i) => (
          <span key={i.label} className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-foreground">
            {i.label}
          </span>
        ))}
    </div>
  );
}
