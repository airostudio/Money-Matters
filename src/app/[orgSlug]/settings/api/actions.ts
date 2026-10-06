"use server";

import { revalidatePath } from "next/cache";
import { rethrowPermissionDenied } from "@/lib/action-errors";
import { requireOrgAndActor } from "@/lib/session";
import { ApiKeyNotFoundError, ApiKeyService, InvalidApiKeyInputError } from "@/domain/api/api-key-service";
import { InvalidScopeError } from "@/domain/api/scopes";
import { InvalidRateLimitError } from "@/domain/api/rate-limit";

/**
 * The state `useFormState` holds for the create-key form. `secret` is present ONLY in the response to the
 * create action that minted the key; it is returned to the browser that asked, held in that form's client state
 * and never put in a URL, a cookie, a redirect, a log or the database. Reload the page and it is gone for good.
 */
export type CreateApiKeyState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "created"; name: string; prefix: string; secret: string };

const FRIENDLY_ERRORS = [InvalidApiKeyInputError, InvalidScopeError, InvalidRateLimitError];

export async function createApiKeyAction(orgSlug: string, _previous: CreateApiKeyState, formData: FormData): Promise<CreateApiKeyState> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);

    const name = formData.get("name");
    const scopes = formData.getAll("scopes").filter((s): s is string => typeof s === "string");
    const expiry = formData.get("expiresOn");
    const rate = formData.get("rateLimit");

    let expiresAt: Date | null = null;
    if (typeof expiry === "string" && expiry.trim() !== "") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return { status: "error", message: "Enter the expiry as a date." };
      // The whole of the chosen day: the key works through it and stops at the end of it (UTC).
      expiresAt = new Date(`${expiry}T23:59:59.000Z`);
      if (Number.isNaN(expiresAt.getTime())) return { status: "error", message: "Enter the expiry as a date." };
    }
    let rateLimitPerMinute: number | null = null;
    if (typeof rate === "string" && rate.trim() !== "") {
      rateLimitPerMinute = Number(rate);
      if (!Number.isInteger(rateLimitPerMinute)) return { status: "error", message: "The rate limit must be a whole number of requests per minute." };
    }

    try {
      const created = await ApiKeyService.create(actor, {
        name: typeof name === "string" ? name : "",
        scopes,
        expiresAt,
        rateLimitPerMinute,
      });
      revalidatePath(`/${orgSlug}/settings/api`);
      return { status: "created", name: created.key.name, prefix: created.key.prefix, secret: created.secret };
    } catch (error) {
      if (FRIENDLY_ERRORS.some((E) => error instanceof E)) return { status: "error", message: (error as Error).message };
      throw error;
    }
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function revokeApiKeyAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const keyId = formData.get("keyId");
    if (typeof keyId !== "string") return;
    try {
      await ApiKeyService.revoke(actor, keyId);
    } catch (error) {
      if (error instanceof ApiKeyNotFoundError) return;
      throw error;
    }
    revalidatePath(`/${orgSlug}/settings/api`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
