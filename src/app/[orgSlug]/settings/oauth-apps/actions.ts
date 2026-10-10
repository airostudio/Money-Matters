"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rethrowPermissionDenied } from "@/lib/action-errors";
import { requireOrgAndActor } from "@/lib/session";
import { OAuthAppService } from "@/domain/oauth/app-service";
import { InvalidOAuthInputError, OAuthAppLimitError, OAuthAppNotFoundError, OAuthGrantNotFoundError } from "@/domain/oauth/errors";
import { OAuthGrantService } from "@/domain/oauth/grant-service";
import { InvalidScopeError } from "@/domain/api/scopes";

/**
 * Server actions for Settings > Connected apps. Every one resolves the Actor through `requireOrgAndActor` (archived
 * organization refused, membership checked) and the domain service then enforces `oauth_app:manage` + HUMAN. The client
 * secret exists only in the response to `createOAuthAppAction` / `rotateOAuthSecretAction`: it is held in that form's
 * client state, never put in a URL, cookie, redirect, log or the database (only its hash is stored).
 */
export type CreateOAuthAppState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "created"; name: string; clientId: string; clientSecret: string | null };

export type RotateOAuthSecretState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "rotated"; clientSecret: string };

const FRIENDLY = [InvalidOAuthInputError, InvalidScopeError, OAuthAppLimitError, OAuthAppNotFoundError, OAuthGrantNotFoundError];

function isFriendly(error: unknown): error is Error {
  return FRIENDLY.some((E) => error instanceof E);
}

function parseForm(formData: FormData) {
  const text = (key: string) => {
    const v = formData.get(key);
    return typeof v === "string" ? v : "";
  };
  return {
    name: text("name"),
    description: text("description"),
    homepageUrl: text("homepageUrl"),
    redirectUris: text("redirectUris")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== ""),
    scopes: formData.getAll("scopes").filter((s): s is string => typeof s === "string"),
  };
}

const page = (orgSlug: string) => `/${orgSlug}/settings/oauth-apps`;

export async function createOAuthAppAction(orgSlug: string, _previous: CreateOAuthAppState, formData: FormData): Promise<CreateOAuthAppState> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const type = formData.get("clientType") === "PUBLIC" ? "PUBLIC" : "CONFIDENTIAL";
    try {
      const created = await OAuthAppService.create(actor, { ...parseForm(formData), clientType: type });
      revalidatePath(page(orgSlug));
      return { status: "created", name: created.app.name, clientId: created.app.clientId, clientSecret: created.clientSecret };
    } catch (error) {
      if (isFriendly(error)) return { status: "error", message: error.message };
      throw error;
    }
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function rotateOAuthSecretAction(orgSlug: string, _previous: RotateOAuthSecretState, formData: FormData): Promise<RotateOAuthSecretState> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const appId = formData.get("appId");
    if (typeof appId !== "string") return { status: "error", message: "Missing app." };
    try {
      const rotated = await OAuthAppService.rotateSecret(actor, appId);
      revalidatePath(page(orgSlug));
      return { status: "rotated", clientSecret: rotated.clientSecret };
    } catch (error) {
      if (isFriendly(error)) return { status: "error", message: error.message };
      throw error;
    }
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

async function run(orgSlug: string, work: (actor: Awaited<ReturnType<typeof requireOrgAndActor>>["actor"]) => Promise<unknown>): Promise<void> {
  let message: string | null = null;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      await work(actor);
    } catch (error) {
      if (!isFriendly(error)) throw error;
      message = error.message;
    }
    revalidatePath(page(orgSlug));
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
  if (message) redirect(`${page(orgSlug)}?error=${encodeURIComponent(message.slice(0, 400))}`);
}

export async function updateOAuthAppAction(orgSlug: string, formData: FormData): Promise<void> {
  const appId = formData.get("appId");
  if (typeof appId !== "string") return;
  await run(orgSlug, (actor) => OAuthAppService.update(actor, appId, parseForm(formData)));
}

export async function setOAuthAppDisabledAction(orgSlug: string, formData: FormData): Promise<void> {
  const appId = formData.get("appId");
  if (typeof appId !== "string") return;
  await run(orgSlug, (actor) => OAuthAppService.setDisabled(actor, appId, formData.get("disable") === "true"));
}

export async function deleteOAuthAppAction(orgSlug: string, formData: FormData): Promise<void> {
  const appId = formData.get("appId");
  if (typeof appId !== "string") return;
  await run(orgSlug, (actor) => OAuthAppService.delete(actor, appId));
}

export async function revokeOAuthGrantAction(orgSlug: string, formData: FormData): Promise<void> {
  const grantId = formData.get("grantId");
  if (typeof grantId !== "string") return;
  await run(orgSlug, (actor) => OAuthGrantService.revoke(actor, grantId));
}
