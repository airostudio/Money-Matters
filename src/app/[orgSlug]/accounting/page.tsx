import { redirect } from "next/navigation";

export default function AccountingIndexPage({ params }: { params: { orgSlug: string } }) {
  redirect(`/${params.orgSlug}/accounting/chart-of-accounts`);
}
