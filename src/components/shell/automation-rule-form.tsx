"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RuleFormState } from "@/app/[orgSlug]/settings/automation/actions";

export interface FieldOption {
  name: string;
  label: string;
  kind: "decimal" | "integer" | "uuid" | "enum" | "currency";
  values?: string[];
  /** For a record reference (a customer or supplier): the people / companies to pick from, so nobody has to type an id. */
  choices?: { value: string; label: string }[];
  operators: { value: string; label: string }[];
}

export interface TriggerOption {
  id: string;
  label: string;
  description: string;
  fields: FieldOption[];
  /** Present for the scan triggers that take a number of days. */
  days: { label: string; min: number; max: number; default: number } | null;
  /** Action types that may be combined with this trigger. */
  actions: string[];
}

export interface ActionOption {
  type: string;
  label: string;
  description: string;
  reversibleBy: string;
  writes: boolean;
}

export interface RuleFormConfig {
  triggers: TriggerOption[];
  actions: ActionOption[];
  roles: { value: string; label: string }[];
  channels: { id: string; name: string; providerName: string; status: string }[];
  maxConditions: number;
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving..." : "Create rule"}
    </Button>
  );
}

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

/**
 * The rule builder. Everything offered here comes from the closed vocabulary (triggers, per-trigger fields, operators per
 * field kind, the four actions); the server validates the posted values again, field by field. Presentation only.
 */
export function AutomationRuleForm({ action, config }: { action: (previous: RuleFormState, formData: FormData) => Promise<RuleFormState>; config: RuleFormConfig }) {
  const [state, formAction] = useFormState(action, { status: "idle" } as RuleFormState);
  const [triggerId, setTriggerId] = useState(config.triggers[0]?.id ?? "");
  const [actionType, setActionType] = useState("NOTIFY_IN_APP");
  const [rows, setRows] = useState<number>(0);
  const trigger = config.triggers.find((t) => t.id === triggerId) ?? config.triggers[0]!;
  const allowedActions = config.actions.filter((a) => trigger.actions.includes(a.type));
  const effectiveAction = allowedActions.some((a) => a.type === actionType) ? actionType : (allowedActions[0]?.type ?? "NOTIFY_IN_APP");
  const actionInfo = config.actions.find((a) => a.type === effectiveAction);

  return (
    <form action={formAction} className="space-y-5" data-testid="rule-form">
      {state.status === "error" && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="rule-name">Rule name</Label>
          <Input id="rule-name" name="name" maxLength={80} required placeholder="e.g. Tell me about large invoices" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rule-description">Note (optional)</Label>
          <Input id="rule-description" name="description" maxLength={300} placeholder="Why this rule exists" />
        </div>
      </div>

      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium">WHEN</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="rule-trigger">This happens</Label>
            <select id="rule-trigger" name="trigger" className={selectClass} value={triggerId} onChange={(e) => setTriggerId(e.target.value)}>
              {config.triggers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{trigger.description}</p>
          </div>
          {trigger.days && (
            <div className="space-y-2">
              <Label htmlFor="rule-days">{trigger.days.label}</Label>
              <Input id="rule-days" name="days" type="number" inputMode="numeric" min={trigger.days.min} max={trigger.days.max} defaultValue={trigger.days.default} required />
            </div>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">AND (optional conditions, all must hold)</p>
          {Array.from({ length: rows }, (_, i) => (
            <ConditionRow key={`${triggerId}-${i}`} index={i} fields={trigger.fields} />
          ))}
          {rows < config.maxConditions && trigger.fields.length > 0 && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setRows(rows + 1)}>
              Add a condition
            </Button>
          )}
          {rows > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setRows(rows - 1)}>
              Remove the last condition
            </Button>
          )}
          <p className="text-xs text-muted-foreground">Amounts are compared exactly as decimals, in the document&apos;s own currency.</p>
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium">THEN</legend>
        <div className="space-y-2">
          <Label htmlFor="rule-action">Do this</Label>
          <select id="rule-action" name="actionType" className={selectClass} value={effectiveAction} onChange={(e) => setActionType(e.target.value)}>
            {allowedActions.map((a) => (
              <option key={a.type} value={a.type}>
                {a.label}
              </option>
            ))}
          </select>
          {actionInfo && (
            <p className="text-xs text-muted-foreground">
              {actionInfo.description} <span className="font-medium">Undo:</span> {actionInfo.reversibleBy}
            </p>
          )}
        </div>

        {effectiveAction === "NOTIFY_IN_APP" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Notify these roles</p>
              <div className="grid gap-1 sm:grid-cols-3">
                {config.roles.map((r) => (
                  <label key={r.value} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="roles" value={r.value} defaultChecked={r.value === "OWNER"} />
                    {r.label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Only people whose role can already see the item are notified.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="rule-severity">Importance</Label>
                <select id="rule-severity" name="severity" className={selectClass} defaultValue="INFO">
                  <option value="INFO">Information</option>
                  <option value="ACTION">Needs action</option>
                  <option value="WARNING">Warning</option>
                  <option value="CRITICAL">Critical</option>
                </select>
              </div>
              <label className="flex items-center gap-2 self-end text-sm">
                <input type="checkbox" name="includeAmounts" />
                Include amounts in the notification
              </label>
            </div>
          </div>
        )}

        {effectiveAction === "SEND_TO_CHANNEL" && (
          <div className="space-y-2">
            <Label htmlFor="rule-channel">Channel</Label>
            {config.channels.length === 0 ? (
              <p className="text-sm text-muted-foreground">No channel is connected yet. Connect one under Settings, Integrations first.</p>
            ) : (
              <select id="rule-channel" name="connectionId" className={selectClass} required>
                {config.channels.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.status !== "CONNECTED"}>
                    {c.name} ({c.providerName}){c.status !== "CONNECTED" ? ` - ${c.status.toLowerCase()}` : ""}
                  </option>
                ))}
              </select>
            )}
            <p className="text-xs text-muted-foreground">Messages are short and carry no amounts unless that channel&apos;s &quot;include amounts&quot; setting is on.</p>
          </div>
        )}

        {(effectiveAction === "NOTIFY_IN_APP" || effectiveAction === "SEND_TO_CHANNEL") && (
          <div className="space-y-2">
            <Label htmlFor="rule-message">Extra text (optional)</Label>
            <Input id="rule-message" name="message" maxLength={200} placeholder="Plain text added in front of the message" />
          </div>
        )}

        {actionInfo?.writes && (
          <div role="note" data-testid="write-warning" className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
            <p className="font-medium">This rule changes your books without anyone clicking.</p>
            <p className="text-xs">
              It will create a <strong>draft</strong> purchase order each time stock reaches the reorder point. It never sends the order, never turns it into a bill and never posts anything. Drafts it makes are labelled
              &quot;Automation&quot; and you can review, edit or delete them. You can pause this rule, or every automation, at any time.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="acknowledgeWriteAction" required className="mt-1" />
              <span>I understand, and I approve this rule to run automatically.</span>
            </label>
          </div>
        )}
      </fieldset>

      <p className="text-xs text-muted-foreground">
        Creating this rule is your approval. It runs with your current role&apos;s permissions or less, and stops by itself if you leave, are suspended, or lose access.
      </p>
      <Submit />
    </form>
  );
}

function ConditionRow({ index, fields }: { index: number; fields: FieldOption[] }) {
  const [fieldName, setFieldName] = useState(fields[0]?.name ?? "");
  const field = fields.find((f) => f.name === fieldName) ?? fields[0]!;
  const [operator, setOperator] = useState(field.operators[0]?.value ?? "eq");
  const operators = field.operators;
  const effectiveOperator = operators.some((o) => o.value === operator) ? operator : (operators[0]?.value ?? "eq");
  return (
    <div className="grid gap-2 sm:grid-cols-3" data-testid={`condition-${index}`}>
      <select name={`cond_field_${index}`} className={selectClass} value={field.name} onChange={(e) => setFieldName(e.target.value)} aria-label="Field">
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label}
          </option>
        ))}
      </select>
      <select name={`cond_op_${index}`} className={selectClass} value={effectiveOperator} onChange={(e) => setOperator(e.target.value)} aria-label="Comparison">
        {operators.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {field.choices && effectiveOperator !== "in" ? (
        <select name={`cond_value_${index}`} className={selectClass} aria-label="Value">
          {field.choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      ) : field.kind === "enum" && effectiveOperator !== "in" ? (
        <select name={`cond_value_${index}`} className={selectClass} aria-label="Value">
          {(field.values ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <Input
          name={`cond_value_${index}`}
          aria-label="Value"
          required
          inputMode={field.kind === "decimal" || field.kind === "integer" ? "decimal" : "text"}
          placeholder={field.kind === "decimal" ? "e.g. 2000.00" : field.kind === "integer" ? "e.g. 7" : field.kind === "uuid" ? "id" : field.kind === "currency" ? "e.g. AUD" : "value"}
          maxLength={64}
        />
      )}
    </div>
  );
}
