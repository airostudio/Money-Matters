import { redirect } from "next/navigation";

// Financial statements, the report builder and the management pack are built under Accounting; this old placeholder redirects.
export default function InsightsPage({ params }: { params: { orgSlug: string } }) {
  redirect(`/${params.orgSlug}/accounting`);
}
