import type { RuleInput } from "@/domain/automation/rule-service";
import { MAX_CONDITIONS } from "@/domain/automation/vocabulary";

const text = (value: FormDataEntryValue | null): string => (typeof value === "string" ? value : "");

/** Turns the posted form into a `RuleInput`. Pure text handling: no field name or value is ever used as code. The service validates every part again. */
export function ruleInputFromForm(formData: FormData): RuleInput {
  const conditions: unknown[] = [];
  for (let i = 0; i < MAX_CONDITIONS; i += 1) {
    const field = text(formData.get(`cond_field_${i}`)).trim();
    if (!field) continue;
    const operator = text(formData.get(`cond_op_${i}`)).trim();
    const raw = text(formData.get(`cond_value_${i}`)).trim();
    conditions.push({ field, operator, value: operator === "in" ? raw.split(/[\s,]+/).filter(Boolean) : raw });
  }
  const type = text(formData.get("actionType"));
  let action: unknown = { type };
  if (type === "NOTIFY_IN_APP") {
    action = {
      type,
      roles: formData.getAll("roles").filter((v): v is string => typeof v === "string"),
      userIds: [],
      severity: text(formData.get("severity")) || "INFO",
      message: text(formData.get("message")).trim() || undefined,
      includeAmounts: formData.get("includeAmounts") === "on",
    };
  } else if (type === "SEND_TO_CHANNEL") {
    action = { type, connectionId: text(formData.get("connectionId")), message: text(formData.get("message")).trim() || undefined };
  }
  const days = text(formData.get("days")).trim();
  return {
    name: text(formData.get("name")),
    description: text(formData.get("description")).trim() || null,
    trigger: text(formData.get("trigger")),
    triggerParams: days ? { days } : {},
    conditions,
    action,
    acknowledgeWriteAction: formData.get("acknowledgeWriteAction") === "on",
  };
}
