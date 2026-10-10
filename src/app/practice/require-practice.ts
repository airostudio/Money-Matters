import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { PracticeService } from "@/domain/practice/practice-service";
import type { PracticeActor, PracticeRole } from "@/domain/practice/types";

export const PRACTICE_COOKIE = "mm_practice";

export interface CurrentPractice {
  id: string;
  name: string;
  role: PracticeRole;
}

/**
 * The gate for every practice page, route handler and server action: resolves the signed-in user
 * (a suspended or deleted account resolves to "not signed in") and hands back the PRACTICE-level
 * actor. A practice belongs to no organization, so there is no organization slug here — each
 * client's own permissions are checked inside the services, per client, with the user's real
 * membership role in it.
 */
export async function requirePracticeUser(): Promise<{ user: { id: string; name: string; email: string }; actor: PracticeActor }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return { user, actor: { userId: user.id } };
}

/** The practices the user belongs to and the one in use (their chosen one, else the first). */
export async function resolvePractice(actor: PracticeActor): Promise<{ practices: CurrentPractice[]; current: CurrentPractice | null }> {
  const practices = (await PracticeService.listMine(actor)) as CurrentPractice[];
  const chosen = cookies().get(PRACTICE_COOKIE)?.value;
  const current = practices.find((p) => p.id === chosen) ?? practices[0] ?? null;
  return { practices, current };
}

/** For pages that only make sense inside a practice: sends someone with none to the set-up page. */
export async function requireCurrentPractice() {
  const { user, actor } = await requirePracticeUser();
  const { practices, current } = await resolvePractice(actor);
  if (!current) redirect("/practice");
  return { user, actor, practices, practice: current };
}

/** Reads a short, safe error message from a `?error=` query value. */
export function errorParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value ? value.slice(0, 600) : null;
}
