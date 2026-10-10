"use client";

import { Button } from "@/components/ui/button";

/** Opens the browser's print dialog (the payslip page has print styles that hide the app chrome). */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button type="button" size="sm" variant="outline" className="print:hidden" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
