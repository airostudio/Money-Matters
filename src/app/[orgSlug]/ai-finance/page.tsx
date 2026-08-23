import { Bot } from "lucide-react";
import { ComingSoon } from "@/components/shell/coming-soon";

export default function AiFinancePage() {
  return (
    <ComingSoon
      icon={Bot}
      title="AI Finance"
      phase={6}
      blurb="The AI Financial Controller, specialist finance agents, and the command bar — see docs/ai-agents.md for the architecture already in place."
    />
  );
}
