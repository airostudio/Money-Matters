import { NextResponse } from "next/server";
import { requireOrgAndActor } from "@/lib/session";
import { PayrollPaymentService } from "@/domain/payroll/payroll-payment-service";

/**
 * Generates and downloads an ABA (Direct Entry) file for a POSTED pay run. POST only (the bank identifiers are form
 * fields and are never stored or logged). Errors redirect back to the pay run page with a message.
 */
export async function POST(request: Request, { params }: { params: { orgSlug: string; payRunId: string } }) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  const back = new URL(`/${params.orgSlug}/payroll/pay-runs/${params.payRunId}`, request.url);
  const form = await request.formData();
  const text = (k: string) => String(form.get(k) ?? "").trim();
  try {
    const processingDate = new Date(`${text("processingDate")}T00:00:00.000Z`);
    if (Number.isNaN(processingDate.getTime())) throw new Error("Enter a valid processing date.");
    const result = await PayrollPaymentService.generateAba(actor, params.payRunId, {
      header: {
        financialInstitution: text("financialInstitution"),
        userName: text("userName"),
        userId: text("userId"),
        description: "PAYROLL",
      },
      trace: { bsb: text("traceBsb"), accountNumber: text("traceAccount"), remitterName: text("remitterName") },
      processingDate,
      lodgementReference: text("reference") || undefined,
    });
    return new NextResponse(result.content, {
      headers: {
        "Content-Type": "text/plain; charset=us-ascii",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
        "X-Aba-Total-Cents": result.totalCents,
        "X-Aba-Rounding-Difference": result.roundingDifference,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "PermissionDeniedError") {
      return NextResponse.redirect(new URL(`/${params.orgSlug}/access-denied`, request.url), 303);
    }
    back.searchParams.set("error", error instanceof Error ? error.message : "Could not generate the file.");
    return NextResponse.redirect(back, 303);
  }
}
