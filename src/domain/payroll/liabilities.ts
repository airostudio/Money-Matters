import { and, eq, ne, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { payRunLines, payRuns, payrollPayments } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";

/**
 * Outstanding payroll liabilities, derived from the pay run sub-ledger and the payments recorded against it (not from
 * the GL balance, so a manual journal on the same account cannot make a payment look valid or invalid).
 */

export type RemittanceKind = "SUPER" | "PAYG";

/** Accrued on POSTED pay runs (optionally excluding one run) minus POSTED remittances, for one liability account. */
export async function outstandingRemittance(
  tx: TenantDb,
  organizationId: string,
  kind: RemittanceKind,
  liabilityAccountId: string,
  opts: { excludeRunId?: string } = {},
): Promise<{ accrued: string; paid: string; outstanding: string }> {
  const column = kind === "SUPER" ? payRunLines.superGuarantee : payRunLines.paygWithholding;
  const accountColumn = kind === "SUPER" ? payRuns.superannuationPayableAccountId : payRuns.paygWithholdingPayableAccountId;
  const [accruedRow] = await tx
    .select({ total: sql<string>`coalesce(sum(${column}), 0)` })
    .from(payRunLines)
    .innerJoin(payRuns, eq(payRuns.id, payRunLines.payRunId))
    .where(
      and(
        eq(payRuns.organizationId, organizationId),
        eq(payRuns.status, "POSTED"),
        eq(accountColumn, liabilityAccountId),
        opts.excludeRunId ? ne(payRuns.id, opts.excludeRunId) : undefined,
      ),
    );
  const [paidRow] = await tx
    .select({ total: sql<string>`coalesce(sum(${payrollPayments.amount}), 0)` })
    .from(payrollPayments)
    .where(
      and(
        eq(payrollPayments.organizationId, organizationId),
        eq(payrollPayments.kind, kind),
        eq(payrollPayments.liabilityAccountId, liabilityAccountId),
        eq(payrollPayments.status, "POSTED"),
      ),
    );
  const accrued = new Decimal(accruedRow?.total ?? 0);
  const paid = new Decimal(paidRow?.total ?? 0);
  return { accrued: accrued.toFixed(4), paid: paid.toFixed(4), outstanding: accrued.minus(paid).toFixed(4) };
}

/** Net wages of one POSTED run minus POSTED net-wages payments against it. */
export async function outstandingNetWages(
  tx: TenantDb,
  organizationId: string,
  payRunId: string,
): Promise<{ net: string; paid: string; outstanding: string }> {
  const [netRow] = await tx
    .select({ total: sql<string>`coalesce(sum(${payRunLines.netPay}), 0)` })
    .from(payRunLines)
    .where(and(eq(payRunLines.organizationId, organizationId), eq(payRunLines.payRunId, payRunId)));
  const [paidRow] = await tx
    .select({ total: sql<string>`coalesce(sum(${payrollPayments.amount}), 0)` })
    .from(payrollPayments)
    .where(
      and(
        eq(payrollPayments.organizationId, organizationId),
        eq(payrollPayments.kind, "NET_WAGES"),
        eq(payrollPayments.payRunId, payRunId),
        eq(payrollPayments.status, "POSTED"),
      ),
    );
  const net = new Decimal(netRow?.total ?? 0);
  const paid = new Decimal(paidRow?.total ?? 0);
  return { net: net.toFixed(4), paid: paid.toFixed(4), outstanding: net.minus(paid).toFixed(4) };
}
