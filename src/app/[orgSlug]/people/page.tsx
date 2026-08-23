import { Users } from "lucide-react";
import { ComingSoon } from "@/components/shell/coming-soon";

export default function PeoplePage() {
  return (
    <ComingSoon
      icon={Users}
      title="People"
      phase={8}
      blurb="Employees, Australian payroll, timesheets, and leave."
    />
  );
}
