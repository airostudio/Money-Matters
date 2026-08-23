import { Sparkles } from "lucide-react";
import { ComingSoon } from "@/components/shell/coming-soon";

export default function InsightsPage() {
  return (
    <ComingSoon
      icon={Sparkles}
      title="Insights"
      phase={5}
      blurb="Financial statements, dimensional reporting, and the report builder. For now, see the Trial Balance under Accounting."
    />
  );
}
