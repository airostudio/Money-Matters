"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rethrowPermissionDenied } from "@/lib/action-errors";
import { requireOrgAndActor } from "@/lib/session";
import { IntegrationEncryptionUnavailableError, IntegrationNotFoundError, IntegrationService, InvalidIntegrationInputError } from "@/domain/integrations/connection-service";

/**
 * Server actions for Settings -> Integrations. Each resolves the HUMAN actor from the session and calls a service that
 * itself enforces `integration:manage` + human-only. A secret (the Slack webhook URL) travels only in the POST body of the
 * connect / reconnect form; it is never put in a URL, a redirect, a cookie or a log, and no action returns it. Outcome
 * messages travel as short fixed codes.
 */
export type ConnectFormState = { status: "idle" } | { status: "error"; message: string };

const FRIENDLY = [InvalidIntegrationInputError, IntegrationEncryptionUnavailableError, IntegrationNotFoundError];
const friendly = (error: unknown): string | null => (FRIENDLY.some((E) => error instanceof E) ? (error as Error).message : null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: FormDataEntryValue | null): string | null => (typeof value === "string" && UUID.test(value) ? value : null);
const text = (value: FormDataEntryValue | null): string => (typeof value === "string" ? value : "");

export async function connectSlackAction(orgSlug: string, _previous: ConnectFormState, formData: FormData): Promise<ConnectFormState> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      await IntegrationService.create(actor, {
        providerId: "slack_incoming_webhook",
        name: text(formData.get("name")),
        config: { webhookUrl: text(formData.get("webhookUrl")), includeAmounts: formData.get("includeAmounts") === "on", channelLabel: text(formData.get("channelLabel")).trim() || undefined },
      });
    } catch (error) {
      const message = friendly(error);
      if (message) return { status: "error", message };
      throw error;
    }
    revalidatePath(`/${orgSlug}/settings/integrations`);
    redirect(`/${orgSlug}/settings/integrations?notice=connected`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function reconnectAction(orgSlug: string, connectionId: string, _previous: ConnectFormState, formData: FormData): Promise<ConnectFormState> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      await IntegrationService.reconnect(actor, connectionId, { webhookUrl: text(formData.get("webhookUrl")), includeAmounts: formData.get("includeAmounts") === "on", channelLabel: text(formData.get("channelLabel")).trim() || undefined });
    } catch (error) {
      const message = friendly(error);
      if (message) return { status: "error", message };
      throw error;
    }
    revalidatePath(`/${orgSlug}/settings/integrations`);
    redirect(`/${orgSlug}/settings/integrations?notice=reconnected`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function testConnectionAction(orgSlug: string, formData: FormData): Promise<void> {
  const back = `/${orgSlug}/settings/integrations`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const id = idOf(formData.get("connectionId"));
    if (!id) return;
    let notice: string;
    try {
      const result = await IntegrationService.test(actor, id);
      notice = result.ok ? "test_ok" : `test_failed&class=${encodeURIComponent((result.errorClass ?? "error").replace(/[^a-z_]/g, "").slice(0, 30))}`;
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

export async function disconnectAction(orgSlug: string, formData: FormData): Promise<void> {
  const back = `/${orgSlug}/settings/integrations`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const id = idOf(formData.get("connectionId"));
    if (!id) return;
    try {
      await IntegrationService.disconnect(actor, id);
    } catch (error) {
      if (error instanceof IntegrationNotFoundError) return;
      throw error;
    }
    revalidatePath(back);
    redirect(`${back}?notice=disconnected`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function removeConnectionAction(orgSlug: string, formData: FormData): Promise<void> {
  const back = `/${orgSlug}/settings/integrations`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const id = idOf(formData.get("connectionId"));
    if (!id) return;
    try {
      await IntegrationService.remove(actor, id);
    } catch (error) {
      if (error instanceof IntegrationNotFoundError || error instanceof InvalidIntegrationInputError) return;
      throw error;
    }
    revalidatePath(back);
    redirect(`${back}?notice=removed`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function updateConnectionSettingsAction(orgSlug: string, formData: FormData): Promise<void> {
  const back = `/${orgSlug}/settings/integrations`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const id = idOf(formData.get("connectionId"));
    if (!id) return;
    try {
      await IntegrationService.updateSettings(actor, id, { settings: { includeAmounts: formData.get("includeAmounts") === "on" } });
    } catch (error) {
      if (!friendly(error)) throw error;
    }
    revalidatePath(back);
    redirect(`${back}?notice=saved`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
