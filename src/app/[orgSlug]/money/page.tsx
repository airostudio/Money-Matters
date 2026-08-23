import { Banknote } from "lucide-react";
import { ComingSoon } from "@/components/shell/coming-soon";

export default function MoneyPage() {
  return (
    <ComingSoon
      icon={Banknote}
      title="Money"
      phase={2}
      blurb="Bank feeds, AI-assisted reconciliation, bank rules, and cash flow."
    />
  );
}
