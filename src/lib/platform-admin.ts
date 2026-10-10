import "server-only";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { isPlatformAdminEmail, type PlatformAdmin } from "@/domain/platform-admin/identity";

/**
 * THE gate for the platform admin section. Every admin page, layout, route
 * handler and server action calls this first (the layout alone is not
 * enough — server actions are directly invocable). Signed-out visitors,
 * ordinary users and suspended admins all get `notFound()` — a 404, never a
 * 403 or a redirect — so the section's existence is not revealed.
 *
 * The email compared is the one stored in the database (getCurrentUser reads
 * it fresh, not from the JWT), normalised, against the server-side
 * PLATFORM_ADMIN_EMAILS variable; unset means nobody.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdmin> {
  const user = await getCurrentUser();
  if (!user || !isPlatformAdminEmail(user.email)) notFound();
  return { userId: user.id, email: user.email };
}

/** Server-side only: lets a server component decide whether to render the admin link. */
export function isPlatformAdminUser(user: { email: string } | null): boolean {
  return !!user && isPlatformAdminEmail(user.email);
}
