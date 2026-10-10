import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";

export default async function PayrollRootPage({ params }: { params: { orgSlug: string } }) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  // A member without payroll management lands on their own pay and leave page.
  if (roleHasPermission(actor.role, "employee:read")) redirect(`/${params.orgSlug}/payroll/employees`);
  redirect(`/${params.orgSlug}/payroll/my`);
}
