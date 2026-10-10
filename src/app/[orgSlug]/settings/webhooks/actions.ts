"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rethrowPermissionDenied } from "@/lib/action-errors";
import { requireOrgAndActor } from "@/lib/session";
import { AutomationEngine } from "@/domain/automation/engine";
import { ReplayRefusedError, WebhookDispatchService } from "@/domain/webhooks/dispatch-service";
import { WebhookEncryptionUnavailableError } from "@/domain/webhooks/secret-crypto";
import { InvalidWebhookInputError, WebhookNotFoundError, WebhookSubscriptionService } from "@/domain/webhooks/subscription-service";

/**
 * Server actions for Settings -> Webhooks. Every one resolves the HUMAN actor from the session and calls a service that
 * itself enforces `webhook:manage` + human-only; a refusal redirects to the friendly access-denied page. A signing secret
 * is returned ONLY in the response to the create / rotate action that minted it (held in that form's client state) and is
 * never put in a URL, a cookie, a redirect, a log or the database in plain text. Outcome messages travel as short fixed
 * codes in the query string, never as free text.
 */
export type CreateWebhookState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "created"; url: string; secret: string };

export type RotateSecretState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "rotated"; secret: string; validUntil: string };

const FRIENDLY = [InvalidWebhookInputError, WebhookEncryptionUnavailableError, ReplayRefusedError, WebhookNotFoundError];

function friendly(error: unknown): string | null {
  return FRIENDLY.some((E) => error instanceof E) ? (error as Error).message : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: FormDataEntryValue | null): string | null => (typeof value === "string" && UUID.test(value) ? value : null);

function eventTypesOf(formData: FormData): string[] {
  return formData.getAll("eventTypes").filter((v): v is string => typeof v === "string");
}

export async function createWebhookAction(orgSlug: string, _previous: CreateWebhookState, formData: FormData): Promise<CreateWebhookState> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      const created = await WebhookSubscriptionService.create(actor, {
        url: String(formData.get("url") ?? ""),
        description: String(formData.get("description") ?? ""),
        eventTypes: eventTypesOf(formData),
      });
      revalidatePath(`/${orgSlug}/settings/webhooks`);
      return { status: "created", url: created.subscription.url, secret: created.secret };
    } catch (error) {
      const message = friendly(error);
      if (message) return { status: "error", message };
      throw error;
    }
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function rotateSecretAction(orgSlug: string, subscriptionId: string, _previous: RotateSecretState, _formData: FormData): Promise<RotateSecretState> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      const rotated = await WebhookSubscriptionService.rotateSecret(actor, subscriptionId);
      revalidatePath(`/${orgSlug}/settings/webhooks`);
      return { status: "rotated", secret: rotated.secret, validUntil: rotated.previousSecretValidUntil.toISOString() };
    } catch (error) {
      const message = friendly(error);
      if (message) return { status: "error", message };
      throw error;
    }
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function updateWebhookAction(orgSlug: string, subscriptionId: string, formData: FormData): Promise<void> {
  const back = `/${orgSlug}/settings/webhooks/${subscriptionId}`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      await WebhookSubscriptionService.update(actor, subscriptionId, {
        url: String(formData.get("url") ?? ""),
        description: String(formData.get("description") ?? ""),
        eventTypes: eventTypesOf(formData),
      });
    } catch (error) {
      if (friendly(error)) redirect(`${back}?notice=invalid_input`);
      throw error;
    }
    revalidatePath(back);
    redirect(`${back}?notice=saved`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function setWebhookStatusAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const id = idOf(formData.get("subscriptionId"));
    const status = formData.get("status");
    if (!id || (status !== "ACTIVE" && status !== "PAUSED")) return;
    try {
      await WebhookSubscriptionService.setStatus(actor, id, status);
    } catch (error) {
      if (error instanceof WebhookNotFoundError) return;
      throw error;
    }
    revalidatePath(`/${orgSlug}/settings/webhooks`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function deleteWebhookAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const id = idOf(formData.get("subscriptionId"));
    if (!id) return;
    try {
      await WebhookSubscriptionService.remove(actor, id);
    } catch (error) {
      if (error instanceof WebhookNotFoundError) return;
      throw error;
    }
    revalidatePath(`/${orgSlug}/settings/webhooks`);
    redirect(`/${orgSlug}/settings/webhooks`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

/** "Send test event": a signed ping to one endpoint, outcome shown on the subscription page. */
export async function sendTestEventAction(orgSlug: string, subscriptionId: string): Promise<void> {
  const back = `/${orgSlug}/settings/webhooks/${subscriptionId}`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    let notice: string;
    try {
      const outcome = await WebhookDispatchService.sendTestEvent(actor, subscriptionId);
      notice = outcome.success ? `test_ok&status=${outcome.result.statusCode ?? 0}` : `test_failed&status=${outcome.result.statusCode ?? 0}&class=${encodeURIComponent((outcome.result.errorClass ?? "error").replace(/[^a-z_]/g, "").slice(0, 30))}`;
    } catch (error) {
      if (!friendly(error)) throw error;
      notice = "test_refused";
    }
    revalidatePath(back);
    redirect(`${back}?notice=${notice}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

/** "Send pending / retry failed now": one bounded, on-demand dispatch for this organization. */
export async function sendPendingNowAction(orgSlug: string): Promise<void> {
  const back = `/${orgSlug}/settings/webhooks`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const result = await WebhookDispatchService.dispatchNow(actor);
    // Event-driven automations are evaluated whenever the outbox is dispatched (Phase 10 Slice 3). Sequential, after the dispatch, never throwing into this action.
    try {
      await AutomationEngine.runPass(actor.organizationId, { source: "OUTBOX_DISPATCH" });
    } catch {
      // Best effort: "Run automations now" does the same on demand.
    }
    revalidatePath(back);
    const notice = result.skipped ? "dispatch_disabled" : `dispatched&sent=${result.delivered}&failed=${result.failed}`;
    redirect(`${back}?notice=${notice}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function replayDeliveryAction(orgSlug: string, deliveryId: string): Promise<void> {
  const back = `/${orgSlug}/settings/webhooks/deliveries/${deliveryId}`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    let notice: string;
    try {
      const outcome = await WebhookDispatchService.replay(actor, deliveryId);
      notice = outcome.success ? "replay_ok" : `replay_failed&status=${outcome.result.statusCode ?? 0}`;
    } catch (error) {
      if (!friendly(error)) throw error;
      notice = "replay_refused";
    }
    revalidatePath(back);
    redirect(`${back}?notice=${notice}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
