import { and, asc, desc, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import { accounts, employees, payRunLines, payRuns, payrollPayments } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { generateAbaFile, type AbaHeader, type AbaResult, type AbaTrace } from "./aba-file";
import { PayrollPaymentError, PayRunNotPostedError } from "./errors";
import { outstandingNetWages, outstandingRemittance } from "./liabilities";
import { loadPayRunOr404 } from "./pay-run-service";

export type PayrollPaymentRow = typeof payrollPayments.$inferSelect;

const iso = (d: Date) => d.toISOString().slice(0, 10);

function assertHuman(actor: Actor, permission: "payroll_payment:manage"): void {
  assertPermission(actor, permission);
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError(permission, actor.role);
}

async function assertBankAccount(tx: TenantDb, organizationId: string, accountId: string): Promise<void> {
  const [acct] = await tx
    .select({ type: accounts.type, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!acct) throw new PayrollPaymentError("The bank account was not found.");
  if (acct.type !== "ASSET") throw new PayrollPaymentError("The paying account must be an ASSET (bank) account.");
  if (!acct.isActive) throw new PayrollPaymentError("The paying bank account is inactive.");
}

function parseAmount(raw: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(raw);
  } catch {
    throw new PayrollPaymentError("Enter a valid amount.");
  }
  if (!d.isFinite() || d.lte(0)) throw new PayrollPaymentError("The amount must be greater than zero.");
  return d;
}

async function insertPayment(
  tx: TenantDb,
  actor: Actor,
  values: {
    kind: "NET_WAGES" | "SUPER" | "PAYG";
    payRunId: string | null;
    amount: Decimal;
    paymentDate: Date;
    liabilityAccountId: string;
    bankAccountId: string;
    reference: string | null;
    memo: string;
  },
): Promise<PayrollPaymentRow> {
  const amount = values.amount.toFixed(4);
  // Dr the payable (clears the liability) / Cr the bank. Through PostingService, so the period lock, balance and
  // account checks all apply.
  const posted = await PostingService.postJournal(actor, {
    postingDate: values.paymentDate,
    memo: values.memo,
    sourceType: "MANUAL",
    lines: [
      { accountId: values.liabilityAccountId, debit: amount, currency: "AUD" },
      { accountId: values.bankAccountId, credit: amount, currency: "AUD" },
    ],
  });
  const [row] = await tx
    .insert(payrollPayments)
    .values({
      organizationId: actor.organizationId,
      kind: values.kind,
      payRunId: values.payRunId,
      amount,
      paymentDate: values.paymentDate,
      liabilityAccountId: values.liabilityAccountId,
      bankAccountId: values.bankAccountId,
      reference: values.reference,
      journalEntryId: posted.entryId,
      createdById: actor.userId,
    })
    .returning();
  if (!row) throw new Error("Failed to record the payroll payment.");
  await AuditService.record(tx, actor, {
    action: `payroll_payment.${values.kind.toLowerCase()}_recorded`,
    entityType: "PayrollPayment",
    entityId: row.id,
    after: { kind: values.kind, amount, paymentDate: iso(values.paymentDate), journalEntryId: posted.entryId, payRunId: values.payRunId },
  });
  return row;
}

/**
 * Payroll payments (Phase 8 Slice 3). All of these RECORD money that a person paid out elsewhere; Money Matters makes
 * no bank transfer, uses no clearing house and pays nothing to the ATO.
 * - `payNetWages`: Dr Net Wages Payable / Cr bank, for what is still owed on one POSTED pay run.
 * - `recordSuperRemittance` / `recordPaygRemittance`: Dr Superannuation Payable (or PAYG Withholding Payable) / Cr bank,
 *   capped at what posted pay runs say is outstanding.
 * Posted payments are never edited; `reverse` posts a reversing journal and flags the row REVERSED.
 */
export const PayrollPaymentService = {
  async listForRun(actor: Actor, payRunId: string): Promise<PayrollPaymentRow[]> {
    assertPermission(actor, "payroll_payment:read");
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(payrollPayments)
        .where(and(eq(payrollPayments.organizationId, actor.organizationId), eq(payrollPayments.payRunId, payRunId)))
        .orderBy(asc(payrollPayments.createdAt)),
    );
  },

  async listRemittances(actor: Actor, kind: "SUPER" | "PAYG"): Promise<PayrollPaymentRow[]> {
    assertPermission(actor, "payroll_payment:read");
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(payrollPayments)
        .where(and(eq(payrollPayments.organizationId, actor.organizationId), eq(payrollPayments.kind, kind)))
        .orderBy(desc(payrollPayments.paymentDate)),
    );
  },

  async netWagesPosition(actor: Actor, payRunId: string) {
    assertPermission(actor, "payroll_payment:read");
    return withTenant(actor.organizationId, (tx) => outstandingNetWages(tx, actor.organizationId, payRunId));
  },

  async remittancePosition(actor: Actor, kind: "SUPER" | "PAYG", liabilityAccountId: string) {
    assertPermission(actor, "payroll_payment:read");
    return withTenant(actor.organizationId, (tx) => outstandingRemittance(tx, actor.organizationId, kind, liabilityAccountId));
  },

  /** Pays (records) all net wages still owed on a POSTED pay run. */
  async payNetWages(
    actor: Actor,
    payRunId: string,
    input: { bankAccountId: string; paymentDate: Date; reference?: string },
  ): Promise<PayrollPaymentRow> {
    assertHuman(actor, "payroll_payment:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const run = await loadPayRunOr404(tx, actor.organizationId, payRunId);
      if (run.status !== "POSTED") throw new PayRunNotPostedError(payRunId, run.status);
      await assertBankAccount(tx, actor.organizationId, input.bankAccountId);
      const pos = await outstandingNetWages(tx, actor.organizationId, payRunId);
      const outstanding = new Decimal(pos.outstanding);
      if (outstanding.lte(0)) throw new PayrollPaymentError("Net wages for this pay run are already paid in full.");
      return insertPayment(tx, actor, {
        kind: "NET_WAGES",
        payRunId,
        amount: outstanding,
        paymentDate: input.paymentDate,
        liabilityAccountId: run.netWagesPayableAccountId,
        bankAccountId: input.bankAccountId,
        reference: input.reference?.trim() || null,
        memo: `Net wages paid - pay run ${iso(run.periodStart)} to ${iso(run.periodEnd)}`,
      });
    });
  },

  /** Records a superannuation remittance (record-only; no clearing house). */
  async recordSuperRemittance(
    actor: Actor,
    input: { liabilityAccountId: string; bankAccountId: string; amount: string; paymentDate: Date; reference?: string },
  ): Promise<PayrollPaymentRow> {
    return recordRemittance(actor, "SUPER", input);
  },

  /** Records a PAYG withholding remittance (record-only; nothing is paid to the ATO from here). */
  async recordPaygRemittance(
    actor: Actor,
    input: { liabilityAccountId: string; bankAccountId: string; amount: string; paymentDate: Date; reference?: string },
  ): Promise<PayrollPaymentRow> {
    return recordRemittance(actor, "PAYG", input);
  },

  async reverse(actor: Actor, paymentId: string, reason: string): Promise<PayrollPaymentRow> {
    assertHuman(actor, "payroll_payment:manage");
    const trimmed = reason.trim();
    if (trimmed.length < 10) throw new PayrollPaymentError("A reason of at least 10 characters is required.");
    return withTenant(actor.organizationId, async (tx) => {
      const [p] = await tx
        .select()
        .from(payrollPayments)
        .where(and(eq(payrollPayments.id, paymentId), eq(payrollPayments.organizationId, actor.organizationId)));
      if (!p) throw new PayrollPaymentError("Payment not found.");
      if (p.status !== "POSTED") throw new PayrollPaymentError("That payment has already been reversed.");
      const reversal = await PostingService.reverseEntry(actor, p.journalEntryId, trimmed);
      const [updated] = await tx
        .update(payrollPayments)
        .set({
          status: "REVERSED",
          reversalJournalEntryId: reversal.entryId,
          reversedAt: new Date(),
          reversedById: actor.userId,
          reversalReason: trimmed,
        })
        .where(eq(payrollPayments.id, paymentId))
        .returning();
      await AuditService.record(tx, actor, {
        action: "payroll_payment.reversed",
        entityType: "PayrollPayment",
        entityId: paymentId,
        before: { status: "POSTED" },
        after: { status: "REVERSED", reversalJournalEntryId: reversal.entryId, reason: trimmed },
      });
      return updated!;
    });
  },

  /**
   * Builds an ABA (Direct Entry) file for a POSTED pay run: one credit per employee for their net pay, to the bank
   * details on their employee record. Needs `employee:manage` as well, because it reads full BSB / account numbers.
   * Fails closed: if any employee lacks bank details or has a net pay that rounds to zero cents, nothing is produced.
   * The originating bank / APCA identifiers are supplied by the person generating the file (never stored). Nothing is
   * transmitted anywhere, and generating the file does NOT record a payment: record it with `payNetWages`.
   */
  async generateAba(
    actor: Actor,
    payRunId: string,
    input: { header: Omit<AbaHeader, "processingDate">; trace: AbaTrace; processingDate: Date; lodgementReference?: string },
  ): Promise<AbaResult & { filename: string }> {
    assertHuman(actor, "payroll_payment:manage");
    assertPermission(actor, "employee:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const run = await loadPayRunOr404(tx, actor.organizationId, payRunId);
      if (run.status !== "POSTED") throw new PayRunNotPostedError(payRunId, run.status);
      const rows = await tx
        .select({ line: payRunLines, employee: employees })
        .from(payRunLines)
        .innerJoin(employees, eq(employees.id, payRunLines.employeeId))
        .where(eq(payRunLines.payRunId, payRunId))
        .orderBy(asc(employees.name));
      const missing = rows.filter((r) => !r.employee.bankBsb || !r.employee.bankAccountNumber).map((r) => r.employee.name);
      if (missing.length > 0) {
        throw new PayrollPaymentError(`No bank details on file for: ${missing.join(", ")}. Add them before generating a file.`);
      }
      const reference = (input.lodgementReference?.trim() || `PAY ${iso(run.payDate)}`).slice(0, 18);
      const result = generateAbaFile(
        { ...input.header, processingDate: input.processingDate },
        input.trace,
        rows.map((r) => ({
          bsb: r.employee.bankBsb!,
          accountNumber: r.employee.bankAccountNumber!,
          amount: r.line.netPay,
          accountTitle: r.employee.bankAccountName?.trim() || r.employee.name,
          lodgementReference: reference,
        })),
      );
      await AuditService.record(tx, actor, {
        action: "payroll_payment.aba_generated",
        entityType: "PayRun",
        entityId: payRunId,
        // Never the bank details themselves: only counts and totals.
        after: { records: result.recordCount, totalCents: result.totalCents, roundingDifference: result.roundingDifference },
      });
      return { ...result, filename: `payroll-${iso(run.payDate)}.aba` };
    });
  },
};

async function recordRemittance(
  actor: Actor,
  kind: "SUPER" | "PAYG",
  input: { liabilityAccountId: string; bankAccountId: string; amount: string; paymentDate: Date; reference?: string },
): Promise<PayrollPaymentRow> {
  assertHuman(actor, "payroll_payment:manage");
  const amount = parseAmount(input.amount);
  return withTenant(actor.organizationId, async (tx) => {
    // The liability account must be the one some posted pay run of this organisation actually credited.
    const [known] = await tx
      .select({ id: payRuns.id })
      .from(payRuns)
      .where(
        and(
          eq(payRuns.organizationId, actor.organizationId),
          eq(payRuns.status, "POSTED"),
          kind === "SUPER"
            ? eq(payRuns.superannuationPayableAccountId, input.liabilityAccountId)
            : eq(payRuns.paygWithholdingPayableAccountId, input.liabilityAccountId),
        ),
      )
      .limit(1);
    if (!known) {
      throw new PayrollPaymentError(
        `That is not the ${kind === "SUPER" ? "Superannuation Payable" : "PAYG Withholding Payable"} account of any posted pay run.`,
      );
    }
    await assertBankAccount(tx, actor.organizationId, input.bankAccountId);
    const pos = await outstandingRemittance(tx, actor.organizationId, kind, input.liabilityAccountId);
    if (amount.gt(pos.outstanding)) {
      throw new PayrollPaymentError(
        `The amount ${amount.toFixed(4)} exceeds what is outstanding (${pos.outstanding}) on posted pay runs.`,
      );
    }
    return insertPayment(tx, actor, {
      kind,
      payRunId: null,
      amount,
      paymentDate: input.paymentDate,
      liabilityAccountId: input.liabilityAccountId,
      bankAccountId: input.bankAccountId,
      reference: input.reference?.trim() || null,
      memo: `${kind === "SUPER" ? "Superannuation" : "PAYG withholding"} remittance recorded (paid outside Money Matters)`,
    });
  });
}
