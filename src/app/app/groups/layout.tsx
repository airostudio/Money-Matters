import Link from "next/link";
import { Building2 } from "lucide-react";
import { requireGroupUser } from "./require-user";

export default async function GroupsLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireGroupUser();

  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-4 sm:px-6">
        <div className="flex items-center gap-3 text-sm">
          <Building2 className="size-5 text-primary" />
          <Link href="/app/groups" className="font-semibold hover:underline">
            Entity groups
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link href="/app" className="text-muted-foreground hover:underline">
            Switch company
          </Link>
        </div>
        <span className="truncate text-xs text-muted-foreground">{user.name}</span>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
