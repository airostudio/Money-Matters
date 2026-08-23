import { Package } from "lucide-react";
import { ComingSoon } from "@/components/shell/coming-soon";

export default function OperationsPage() {
  return (
    <ComingSoon
      icon={Package}
      title="Operations"
      phase={7}
      blurb="Projects, time tracking, inventory, and fixed assets."
    />
  );
}
