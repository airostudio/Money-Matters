import { redirect } from "next/navigation";

// Employees, payroll, leave and payslips are built (Phase 8) under "People & Payroll"; this old placeholder URL redirects.
export default function PeoplePage({ params }: { params: { orgSlug: string } }) {
  redirect(`/${params.orgSlug}/payroll`);
}
