import "server-only";
import * as React from "react";
import { getServerSession } from "next-auth";
import { UserService } from "@/domain/auth/user-service";
import { authOptions } from "./auth";
import { OrganizationService } from "@/domain/organizations/organization-service";
import type { Actor } from "@/domain/permissions/permission-service";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
}

/**
 * React's per-request memoiser where it exists (server components/actions),
 * a pass-through elsewhere (scripts, unit tests). A layout and its page both
 * resolving the current user then cost ONE database lookup, not two — see the
 * connection-pool note in src/db/client.ts.
 */
const memoizePerRequest: <T extends () => Promise<unknown>>(fn: T) => T =
  (React as unknown as { cache?: <T>(fn: T) => T }).cache ?? ((fn) => fn);

async function resolveCurrentUser(): Promise<CurrentUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;

  // JWT sessions are self-contained, so on their own they would keep working
  // after a platform admin suspends the account. Every request therefore
  // re-checks the user row (one primary-key lookup, deduped per request
  // above): a suspended or deleted user resolves to "not signed in" on the
  // very next request, and the email/name come from the database rather than
  // from the token. See the "Suspended users" section of the security doc.
  return UserService.getActiveIdentity(session.user.id);
}

export const getCurrentUser: () => Promise<CurrentUser | null> = memoizePerRequest(resolveCurrentUser);

/** Resolves the authenticated user's Actor for a specific organization, or null if not a member. */
export async function getActorForOrganization(organizationId: string): Promise<Actor | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const membership = await OrganizationService.getMembership(user.id, organizationId);
  if (!membership) return null;

  return { userId: user.id, organizationId, role: membership.role };
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super("No authenticated session.");
    this.name = "NotAuthenticatedError";
  }
}

export class NotAMemberError extends Error {
  constructor() {
    super("The current user is not a member of this organization.");
    this.name = "NotAMemberError";
  }
}

export class OrganizationNotFoundError extends Error {
  constructor(slug: string) {
    super(`No organization found for slug "${slug}".`);
    this.name = "OrganizationNotFoundError";
  }
}

/**
 * Resolves both the organization (by slug, as it appears in the URL) and
 * the current user's Actor within it, in one call — the shape every
 * `[orgSlug]` page needs. Throws if unauthenticated, the org doesn't
 * exist, or the user isn't a member (the [orgSlug] layout already redirects
 * on these, so pages under it can treat this as "always resolves").
 */
export async function requireOrgAndActor(orgSlug: string) {
  const user = await getCurrentUser();
  if (!user) throw new NotAuthenticatedError();

  const org = await OrganizationService.getBySlug(orgSlug);
  if (!org) throw new OrganizationNotFoundError(orgSlug);

  const membership = await OrganizationService.getMembership(user.id, org.id);
  if (!membership) throw new NotAMemberError();

  return {
    org,
    user,
    actor: { userId: user.id, organizationId: org.id, role: membership.role } satisfies Actor,
  };
}

/** Throws instead of returning null — for server components/actions that require a resolved Actor. */
export async function requireActor(organizationId: string): Promise<Actor> {
  const user = await getCurrentUser();
  if (!user) throw new NotAuthenticatedError();

  const membership = await OrganizationService.getMembership(user.id, organizationId);
  if (!membership) throw new NotAMemberError();

  return { userId: user.id, organizationId, role: membership.role };
}
