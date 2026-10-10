import "server-only";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import type { GroupActor } from "@/domain/consolidation/entity-access";

/**
 * The gate for every entity-group page and server action: resolves the signed-in
 * user (a suspended or deleted account resolves to "not signed in") and hands back
 * the user-level actor. A group belongs to a USER, not to an organization, so
 * there is no organization slug here — each entity's own permissions are checked
 * inside the services, per entity, with the user's real role there.
 */
export async function requireGroupUser(): Promise<{ user: { id: string; name: string; email: string }; actor: GroupActor }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return { user, actor: { userId: user.id } };
}
