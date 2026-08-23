import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { LucideIcon } from "lucide-react";

export function ComingSoon({
  icon: Icon,
  title,
  phase,
  blurb,
}: {
  icon: LucideIcon;
  title: string;
  phase: number;
  blurb: string;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="max-w-md text-center">
        <CardHeader className="items-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
            <Icon className="size-6 text-muted-foreground" />
          </div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{blurb}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Planned for Phase {phase} — see{" "}
          <Link
            href="https://github.com/airostudio/Money-Matters/blob/main/docs/roadmap.md"
            className="text-primary hover:underline"
          >
            docs/roadmap.md
          </Link>
          . Nothing here is faked in the meantime.
        </CardContent>
      </Card>
    </div>
  );
}
