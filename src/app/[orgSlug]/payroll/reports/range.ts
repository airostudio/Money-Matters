import { financialYearStart } from "@/domain/payroll/payslip-service";

/** `from`/`to` query params (YYYY-MM-DD) or, by default, the current Australian financial year to today. */
export function fiscalYearRange(from?: string, to?: string): { from: Date; to: Date } {
  const parse = (v: string | undefined) => {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(`${v}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const now = new Date();
  const end = parse(to);
  return {
    from: parse(from) ?? financialYearStart(now),
    to: end ? new Date(end.getTime() + 86399999) : now,
  };
}
