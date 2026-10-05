import { redirect } from "next/navigation";

/** The Forecasting section's landing page is its main view, the Cash Forecast. */
export default function ForecastingIndexPage({ params }: { params: { orgSlug: string } }) {
  redirect(`/${params.orgSlug}/forecasting/cash-flow`);
}
