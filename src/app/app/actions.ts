"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { clientAddress } from "@/domain/api/auth-throttle";
import { ArchiveNotPermittedError, OrganizationNotArchivedError } from "@/domain/organizations/archive-rules";
import { OrganizationLifecycleService } from "@/domain/organizations/lifecycle-service";
import {
  CompanyLimitReachedError,
  CreateCompanyThrottledError,
  OrganizationService,
  SeatLimitReachedError,
  SlugTakenError,
} from "@/domain/organizations/organization-service";
import { AlreadyMemberError } from "@/domain/organizations/membership-rules";
import { InviteInvalidError, InviteService, InviteThrottledError } from "@/domain/organizations/invite-service";

/**
 * Company-level actions that live OUTSIDE any one company's URL: the chooser (`/app`) and its siblings. Each resolves
 * the signed-in user itself (there is no organization-scoped Actor yet - the company being created, joined or
 * restored is not one the person can act inside), and each service it calls re-checks what it needs.
 *
 * Plain `<form action>`s cannot render a returned error, so an expected refusal redirects back with `?error=`.
 */

const NAME = z.string().trim().min(1, "Company name is required").max(200);

function back(path: string, kind: "error" | "joinError", message: string): never {
  redirect(`${path}?${kind}=${encodeURIComponent(message.slice(0, 600))}`);
}

export async function createCompanyAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const parsed = NAME.safeParse(formData.get("name"));
  if (!parsed.success) back("/app/new", "error", parsed.error.issues[0]?.message ?? "Enter a company name.");

  let slug: string;
  try {
    const org = await OrganizationService.createAdditionalCompany(user.id, { name: parsed.data! });
    slug = org.slug;
  } catch (error) {
    if (error instanceof CompanyLimitReachedError || error instanceof CreateCompanyThrottledError || error instanceof SlugTakenError) {
      back("/app/new", "error", error.message);
    }
    throw error;
  }
  // Straight into the onboarding wizard, exactly as registration does.
  redirect(`/${slug}/onboarding`);
}

export async function joinCompanyAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const code = formData.get("code");
  if (typeof code !== "string" || !code.trim()) back("/app", "joinError", "Enter the invite code you were given.");

  let slug: string;
  try {
    const joined = await InviteService.redeem(user.id, code as string, {
      clientKeys: [`ip:${clientAddress(headers())}`],
      via: "chooser",
    });
    slug = joined.organization.slug;
  } catch (error) {
    if (
      error instanceof InviteInvalidError ||
      error instanceof InviteThrottledError ||
      error instanceof SeatLimitReachedError ||
      error instanceof AlreadyMemberError
    ) {
      back("/app", "joinError", error.message);
    }
    throw error;
  }
  redirect(`/${slug}`);
}

export async function restoreCompanyAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const organizationId = formData.get("organizationId");
  if (typeof organizationId !== "string" || !/^[0-9a-f-]{36}$/i.test(organizationId)) back("/app", "error", "That company was not found.");

  let slug: string;
  try {
    const org = await OrganizationLifecycleService.restore(user.id, organizationId as string);
    slug = org.slug;
  } catch (error) {
    if (
      error instanceof ArchiveNotPermittedError ||
      error instanceof OrganizationNotArchivedError ||
      error instanceof CompanyLimitReachedError
    ) {
      back("/app", "error", error.message);
    }
    throw error;
  }
  redirect(`/${slug}`);
}
