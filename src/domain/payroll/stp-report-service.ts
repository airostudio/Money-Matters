import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { withTenant } from "@/db/tenant";
import { loadPayRunOr404, PayRunService } from "./pay-run-service";
import { InvalidPayRunError } from "./errors";
import type { StpShapedReport } from "./types";

/**
 * STP (Single Touch Payroll) Phase 2-SHAPED reporting — this slice builds
 * ONLY the data an STP Phase 2 submission would contain (gross by income
 * type, PAYG withheld, super liability), to prove the data model captures
 * what real STP reporting needs. **It is never actually transmitted to the
 * ATO** — real STP lodgment needs ATO digital-service credentials/an
 * SBR-enabled software ID that this environment doesn't have, the same
 * "defer the real external integration" boundary every other third-party
 * connection in this codebase draws (Basiq, Stripe). Every place this
 * report is shown says "not submitted to the ATO" prominently in the UI,
 * not only in this comment.
 *
 * Only ever built from a POSTED pay run — a DRAFT one hasn't actually
 * incurred the PAYG/super liability yet, so there is nothing real to
 * report.
 */
export const StpReportService = {
  async forPayRun(actor: Actor, payRunId: string): Promise<StpShapedReport> {
    assertPermission(actor, "payrun:read");
    return withTenant(actor.organizationId, async (tx) => {
      const run = await loadPayRunOr404(tx, actor.organizationId, payRunId);
      if (run.status !== "POSTED") {
        throw new InvalidPayRunError("Only a POSTED pay run has an STP-shaped report — this run is still DRAFT.");
      }
      const view = await PayRunService.get(actor, payRunId);

      const currency = "AUD";
      let totalGross = Money.zero(currency);
      let totalPayg = Money.zero(currency);
      let totalSuper = Money.zero(currency);

      const lines = view.lines.map((l) => {
        totalGross = totalGross.add(Money.of(l.grossPay, currency));
        totalPayg = totalPayg.add(Money.of(l.paygWithholding, currency));
        totalSuper = totalSuper.add(Money.of(l.superGuarantee, currency));
        return {
          employeeId: l.employeeId,
          employeeName: l.employeeName,
          incomeType: "SALARY_AND_WAGES" as const,
          grossPayments: l.grossPay,
          paygWithheld: l.paygWithholding,
          superannuationLiability: l.superGuarantee,
        };
      });

      return {
        payRunId: run.id,
        payDate: run.payDate.toISOString().slice(0, 10),
        lines,
        totals: {
          grossPayments: totalGross.toString(),
          paygWithheld: totalPayg.toString(),
          superannuationLiability: totalSuper.toString(),
        },
        notSubmittedToAto: true,
      };
    });
  },
};

