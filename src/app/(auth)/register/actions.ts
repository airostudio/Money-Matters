"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { EmailAlreadyRegisteredError, UserService } from "@/domain/auth/user-service";
import { OrganizationService, SlugTakenError } from "@/domain/organizations/organization-service";
import { slugify } from "@/lib/utils";

const RegisterSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  organizationName: z.string().trim().min(1, "Business name is required").max(200),
});

export async function registerAction(formData: FormData): Promise<void> {
  const parsed = RegisterSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    organizationName: formData.get("organizationName"),
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid input.";
    redirect(`/register?error=${encodeURIComponent(message)}`);
  }

  const { name, email, password, organizationName } = parsed.data;

  try {
    const user = await UserService.register({ name, email, password });

    const baseSlug = slugify(organizationName) || "business";
    try {
      await OrganizationService.createWithOwner(user.id, { slug: baseSlug, name: organizationName });
    } catch (error) {
      if (error instanceof SlugTakenError) {
        const disambiguated = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
        await OrganizationService.createWithOwner(user.id, { slug: disambiguated, name: organizationName });
      } else {
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof EmailAlreadyRegisteredError) {
      redirect(`/register?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  redirect("/login?registered=1");
}
