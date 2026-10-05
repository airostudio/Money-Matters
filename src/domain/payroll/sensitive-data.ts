/**
 * Masking helpers for payroll's two most sensitive stored fields — a TFN
 * (treated with the same sensitivity as a password throughout this
 * codebase, master spec §8/§44) and a bank account number (record-keeping
 * only, same as elsewhere in this app). Neither is ever shown in full to a
 * role without `employee:manage` — see `EmployeeService.get`'s doc comment
 * for where this is applied — and the raw value is redacted out of every
 * audit-log row by `AuditService.REDACTED_FIELDS` (which this module's
 * `tfn` key name is deliberately chosen to match).
 */
export function maskLast4(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.trim();
  if (digits.length <= 4) return "****";
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}
