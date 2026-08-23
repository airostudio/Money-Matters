import "server-only";
import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import { OrganizationService } from "@/domain/organizations/organization-service";
import type { Actor } from "@/domain/permissions/permission-service";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? "",
  };
}

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
