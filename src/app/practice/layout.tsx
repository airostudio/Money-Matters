import Link from "next/link";
import { Briefcase } from "lucide-react";
import { requirePracticeUser, resolvePractice } from "./require-practice";
import { ModeToggle } from "@/components/shell/mode-toggle";
import { getUiMode } from "@/lib/ui-mode";
import { switchPracticeAction } from "./actions";

const TABS = [
  { href: "/practice", label: "Dashboard" },
  { href: "/practice/clients", label: "Clients" },
  { href: "/practice/tasks", label: "Tasks" },
  { href: "/practice/calendar", label: "Tax calendar" },
  { href: "/practice/workpapers", label: "Workpapers" },
  { href: "/practice/staff", label: "Staff" },
];

export default async function PracticeLayout({ children }: { children: React.ReactNode }) {
  const { user, actor } = await requirePracticeUser();
  const { practices, current } = await resolvePractice(actor);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="flex h-14 items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3 text-sm">
            <Briefcase className="size-5 shrink-0 text-primary" />
            <span className="truncate font-semibold">{current ? current.name : "Accountant practice"}</span>
            {practices.length > 1 && (
              <form action={switchPracticeAction} className="flex items-center gap-1">
                <label htmlFor="practiceId" className="sr-only">
                  Switch practice
                </label>
                <select id="practiceId" name="practiceId" defaultValue={current?.id} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                  {practices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button type="submit" className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
                  Switch
                </button>
              </form>
            )}
            <span className="text-muted-foreground">/</span>
            <Link href="/app" className="shrink-0 text-muted-foreground hover:underline">
              My companies
            </Link>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <ModeToggle mode={getUiMode()} />
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">{user.name}</span>
          </div>
        </div>
        {current && (
          <nav aria-label="Practice sections" className="flex gap-1 overflow-x-auto px-4 sm:px-6">
            {TABS.map((t) => (
              <Link key={t.href} href={t.href} className="whitespace-nowrap rounded-t-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
                {t.label}
              </Link>
            ))}
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
