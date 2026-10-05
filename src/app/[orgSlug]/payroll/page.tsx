import { redirect } from "next/navigation";

export default function PayrollRootPage({ params }: { params: { orgSlug: string } }) {
  redirect(`/${params.orgSlug}/payroll/employees`);
}
