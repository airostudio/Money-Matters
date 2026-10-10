"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { EmailAlreadyRegisteredError, UserService } from "@/domain/auth/user-service";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { AlreadyMemberError, SeatLimitReachedError } from "@/domain/organizations/membership-rules";
import { InviteInvalidError, InviteService, InviteThrottledError } from "@/domain/organizations/invite-service";
import { clientAddress } from "@/domain/api/auth-throttle";

const RegisterSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  organizationName: z.string().trim().max(200),
  inviteCode: z.string().trim().max(128),
});

export async function registerAction(formData: FormData): Promise<void> {
  const parsed = RegisterSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    organizationName: formData.get("organizationName") ?? "",
    inviteCode: formData.get("inviteCode") ?? "",
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid input.";
    redirect(`/register?error=${encodeURIComponent(message)}`);
  }

  const { name, email, password, organizationName, inviteCode } = parsed.data;
  // A business name is required unless the person is joining an existing company with an invite code.
  if (!organizationName && !inviteCode) {
    redirect(`/register?error=${encodeURIComponent("Business name is required")}`);
  }

  let nextPath = "/app";
  let notice: string | null = null;
  try {
    const user = await UserService.register({ name, email, password });

    // Redeem the code AFTER the account exists (it is bound to this account's email). A person who redeemed a code does
    // NOT also get a personal company: they came to join an existing one. If the code does not work, fall back to normal
    // registration (their own company, when they gave a business name) and say so clearly - the account is never lost
    // over a bad code. The failure message is the same generic one the chooser shows; it never says why.
    let joinedSlug: string | null = null;
    if (inviteCode) {
      try {
        const joined = await InviteService.redeem(user.id, inviteCode, {
          clientKeys: [`ip:${clientAddress(headers())}`],
          via: "registration",
        });
        joinedSlug = joined.organization.slug;
      } catch (error) {
        if (
          error instanceof InviteInvalidError ||
          error instanceof InviteThrottledError ||
          error instanceof SeatLimitReachedError ||
          error instanceof AlreadyMemberError
        ) {
          notice = `Your account was created, but the invite code could not be used: ${error.message}`;
        } else {
          throw error;
        }
      }
    }

    if (joinedSlug) {
      nextPath = `/${joinedSlug}`;
    } else if (organizationName) {
      const org = await OrganizationService.createWithUniqueSlug(user.id, { name: organizationName });
      // Straight to the onboarding wizard once signed in — a brand-new org only has the two starter system accounts
      // (see OrganizationService), so linking a bank account would otherwise be blocked until the user finds Chart of
      // Accounts on their own.
      nextPath = `/${org.slug}/onboarding`;
      if (notice) notice += " Your own company was set up instead; you can try the code again under Join a company.";
    } else {
      notice ??= "Your account was created. Create a company or join one with an invite code.";
    }
  } catch (error) {
    if (error instanceof EmailAlreadyRegisteredError) {
      redirect(`/register?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  const query = new URLSearchParams({ registered: "1", next: nextPath });
  if (notice) query.set("notice", notice);
  redirect(`/login?${query.toString()}`);
}
