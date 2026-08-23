import { LineChart } from "lucide-react";
import { ComingSoon } from "@/components/shell/coming-soon";

export default function SalesPage() {
  return (
    <ComingSoon
      icon={LineChart}
      title="Sales"
      phase={3}
      blurb="Customers, quotes, invoices, payments, and the customer portal."
    />
  );
}
