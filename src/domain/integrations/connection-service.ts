import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { integrationConnections, integrationEvents, users } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { SecretDecryptionError, SecretEncryptionUnavailableError, decryptSecret, encryptSecret, loadKeyring, secretEncryptionStatus, type Keyring } from "@/domain/security/secret-encryption";
import type { OutboundDeps } from "@/domain/webhooks/outbound";
import { sanitiseError } from "@/domain/webhooks/sanitize";
import type { ChannelMessage, ConnectionStatus, OperationResult } from "./provider";
import { getProvider, isComingSoon } from "./registry";

/**
 * Management of integration connections - the human side of the integration framework (docs/security.md section 19).
 *
 * Gated on `integration:manage` (OWNER / ADMINISTRATOR only) AND on the actor being a HUMAN: an API key, AI agent or
 * automation is refused structurally, and `integration:manage` appears in no API scope, no AI tool and no automation
 * action. (The automation engine's `SEND_TO_CHANNEL` uses `prepareSendIn` / `recordSendIn` below, which need only a
 * connection that a human already configured and that is CONNECTED.)
 *
 * SECRETS: a provider's secret fields are split off by `validateConfig`, serialised and encrypted with AES-256-GCM (the same
 * key and versioning as webhook secrets; additional authenticated data = purpose + organization + connection id). They
 * are shown once at entry, never returned by any method here, never written to the audit log or the integration log, and
 * decrypted only just in time to make a call. With the key missing the whole feature FAILS CLOSED
 * (`IntegrationEncryptionUnavailableError`) and nothing else in the application is affected.
 *
 * CONNECTION DISCIPLINE: network I/O (DNS vetting, the test message, a channel send) never happens inside a database
 * transaction. Each operation is "short read transaction -> I/O -> short write transaction".
 */
export class IntegrationEncryptionUnavailableError extends Error {
  constructor(reason: string) {
    super(`Integrations are disabled: ${reason}`);
    this.name = "IntegrationEncryptionUnavailableError";
  }
}

export class IntegrationNotFoundError extends Error {
  constructor() {
    super("Integration connection not found in this organization.");
    this.name = "IntegrationNotFoundError";
  }
}

export class InvalidIntegrationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIntegrationInputError";
  }
}

export const MAX_CONNECTIONS_PER_ORG = 10;
export const MAX_CONNECTION_NAME = 60;
/** A connection is flagged ERROR after this many consecutive failed sends. */
export const CONNECTION_ERROR_AFTER_FAILURES = 3;

export function assertHumanIntegrationManager(actor: Actor): void {
  assertPermission(actor, "integration:manage");
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError("integration:manage", actor.role);
}

export interface ConnectionSummary {
  id: string;
  providerId: string;
  providerName: string;
  name: string;
  status: ConnectionStatus;
  statusReason: string | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Non-secret settings only: includes a MASKED rendering of the secret, never the secret. */
  publicConfig: Record<string, unknown>;
  canSend: boolean;
  createdAt: Date;
  createdByName: string | null;
}

export interface IntegrationLogEntry {
  id: string;
  kind: string;
  ok: boolean;
  detail: string | null;
  errorClass: string | null;
  statusCode: number | null;
  createdAt: Date;
}

type Row = typeof integrationConnections.$inferSelect;

function summarise(row: Row, createdByName: string | null): ConnectionSummary {
  const provider = getProvider(row.providerId);
  return {
    id: row.id,
    providerId: row.providerId,
    providerName: provider?.name ?? row.providerId,
    name: row.name,
    status: row.status,
    statusReason: row.statusReason,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    publicConfig: row.config as Record<string, unknown>,
    canSend: provider?.capabilities.includes("send") ?? false,
    createdAt: row.createdAt,
    createdByName,
  };
}

/** Audit-safe view of a connection: never any secret material (and not even the masked tail - the audit log needs neither). */
function auditView(row: Pick<Row, "providerId" | "name" | "status" | "statusReason"> & { config: unknown }) {
  const config = { ...((row.config ?? {}) as Record<string, unknown>) };
  delete config.maskedUrl;
  return { providerId: row.providerId, name: row.name, status: row.status, statusReason: row.statusReason, settings: config };
}

function cleanName(value: string | null | undefined): string {
  const name = (value ?? "").trim();
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > MAX_CONNECTION_NAME || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new InvalidIntegrationInputError(`Give the connection a name of 1 to ${MAX_CONNECTION_NAME} characters.`);
  }
  return name;
}

function requireKeys(env: Record<string, string | undefined>): Keyring {
  const result = loadKeyring(env);
  if (!result.ok) throw new IntegrationEncryptionUnavailableError(result.reason);
  return result.keyring;
}

export function integrationEncryptionStatus(env: Record<string, string | undefined> = process.env) {
  return secretEncryptionStatus(env);
}

function encryptSecrets(secrets: Record<string, string>, organizationId: string, connectionId: string, keyring: Keyring) {
  return encryptSecret(JSON.stringify(secrets), { organizationId, subscriptionId: connectionId, purpose: "integration" }, keyring);
}

function decryptSecrets(ciphertext: string, organizationId: string, connectionId: string, keyring: Keyring): Record<string, string> {
  const parsed = JSON.parse(decryptSecret(ciphertext, { organizationId, subscriptionId: connectionId, purpose: "integration" }, keyring)) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new SecretDecryptionError("The stored secret is malformed.");
  return parsed as Record<string, string>;
}

async function appendEvent(
  tx: TenantDb,
  organizationId: string,
  connectionId: string,
  entry: { kind: string; ok: boolean; detail?: string | null; errorClass?: string | null; statusCode?: number | null; actorUserId?: string | null; ruleId?: string | null },
) {
  await tx.insert(integrationEvents).values({
    organizationId,
    connectionId,
    kind: entry.kind,
    ok: entry.ok,
    detail: entry.detail ? sanitiseError(entry.detail) : null,
    errorClass: entry.errorClass ?? null,
    statusCode: entry.statusCode ?? null,
    actorUserId: entry.actorUserId ?? null,
    ruleId: entry.ruleId ?? null,
  });
}

/** What the engine needs to send through a connection, read in its own short transaction. Contains the CIPHERTEXT, never plaintext. */
export interface SendPlan {
  connectionId: string;
  providerId: string;
  config: Record<string, unknown>;
  secretCiphertext: string;
}

export type PrepareSendResult = { ok: true; plan: SendPlan } | { ok: false; reason: string };

export const IntegrationService = {
  /** Every connection of the organization, newest first. Never returns a secret. */
  async list(actor: Actor): Promise<ConnectionSummary[]> {
    assertHumanIntegrationManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({ row: integrationConnections, createdByName: users.name })
        .from(integrationConnections)
        .leftJoin(users, eq(users.id, integrationConnections.createdByUserId))
        .where(eq(integrationConnections.organizationId, actor.organizationId))
        .orderBy(desc(integrationConnections.createdAt));
      return rows.map((r) => summarise(r.row, r.createdByName));
    });
  },

  /**
   * The CONNECTED channels a rule may target: id, name and provider only (no settings, no secrets). Needs only
   * `automation:read`, so a role that can SEE a rule can also see which channel it names.
   */
  async listSendTargets(actor: Actor): Promise<{ id: string; name: string; providerName: string; status: ConnectionStatus }[]> {
    assertPermission(actor, "automation:read");
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({ id: integrationConnections.id, name: integrationConnections.name, providerId: integrationConnections.providerId, status: integrationConnections.status })
        .from(integrationConnections)
        .where(eq(integrationConnections.organizationId, actor.organizationId))
        .orderBy(asc(integrationConnections.name));
      return rows
        .filter((r) => getProvider(r.providerId)?.capabilities.includes("send"))
        .map((r) => ({ id: r.id, name: r.name, providerName: getProvider(r.providerId)?.name ?? r.providerId, status: r.status }));
    });
  },

  /** The latest log entries across ALL connections in one query (the settings page groups them), so the page costs one statement, not one per connection. */
  async recentEventsForAll(actor: Actor, limit = 40): Promise<(IntegrationLogEntry & { connectionId: string })[]> {
    assertHumanIntegrationManager(actor);
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select({ id: integrationEvents.id, connectionId: integrationEvents.connectionId, kind: integrationEvents.kind, ok: integrationEvents.ok, detail: integrationEvents.detail, errorClass: integrationEvents.errorClass, statusCode: integrationEvents.statusCode, createdAt: integrationEvents.createdAt })
        .from(integrationEvents)
        .where(eq(integrationEvents.organizationId, actor.organizationId))
        .orderBy(desc(integrationEvents.createdAt), desc(integrationEvents.id))
        .limit(Math.min(Math.max(limit, 1), 200)),
    );
  },

  async recentEvents(actor: Actor, connectionId: string, limit = 20): Promise<IntegrationLogEntry[]> {
    assertHumanIntegrationManager(actor);
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select({ id: integrationEvents.id, kind: integrationEvents.kind, ok: integrationEvents.ok, detail: integrationEvents.detail, errorClass: integrationEvents.errorClass, statusCode: integrationEvents.statusCode, createdAt: integrationEvents.createdAt })
        .from(integrationEvents)
        .where(and(eq(integrationEvents.organizationId, actor.organizationId), eq(integrationEvents.connectionId, connectionId)))
        .orderBy(desc(integrationEvents.createdAt), desc(integrationEvents.id))
        .limit(Math.min(Math.max(limit, 1), 100)),
    );
  },

  /** Connects a provider. The secret in `config` is validated, vetted (no request to the third party), encrypted and stored; it is returned nowhere. */
  async create(
    actor: Actor,
    input: { providerId: string; name: string; config: unknown },
    deps: OutboundDeps & { env?: Record<string, string | undefined> } = {},
  ): Promise<ConnectionSummary> {
    assertHumanIntegrationManager(actor);
    const keyring = requireKeys(deps.env ?? process.env);
    if (isComingSoon(input.providerId)) throw new InvalidIntegrationInputError("That integration is not available yet.");
    const provider = getProvider(input.providerId);
    if (!provider) throw new InvalidIntegrationInputError("Unknown integration provider.");
    const name = cleanName(input.name);

    const validated = provider.validateConfig(input.config);
    if (!validated.ok) throw new InvalidIntegrationInputError(validated.message);
    const connectionId = randomUUID();
    // Network (DNS vetting) happens BEFORE the transaction opens.
    const connected = await provider.connect({ organizationId: actor.organizationId, connectionId, config: validated.config }, deps);
    if (!connected.ok) throw new InvalidIntegrationInputError(connected.message);

    const encrypted = encryptSecrets(validated.secretConfig, actor.organizationId, connectionId, keyring);
    const now = new Date();
    return withTenant(actor.organizationId, async (tx) => {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(integrationConnections)
        .where(eq(integrationConnections.organizationId, actor.organizationId));
      if (n >= MAX_CONNECTIONS_PER_ORG) throw new InvalidIntegrationInputError(`An organization can have at most ${MAX_CONNECTIONS_PER_ORG} connections. Remove one first.`);
      const [row] = await tx
        .insert(integrationConnections)
        .values({
          id: connectionId,
          organizationId: actor.organizationId,
          providerId: provider.id,
          name,
          config: validated.publicConfig,
          secretCiphertext: encrypted.ciphertext,
          secretKeyVersion: encrypted.keyVersion,
          status: "CONNECTED",
          lastCheckedAt: null,
          createdByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("Failed to create the connection.");
      await appendEvent(tx, actor.organizationId, connectionId, { kind: "CONNECT", ok: true, detail: "Connection created.", actorUserId: actor.userId });
      await AuditService.record(tx, actor, { action: "integration.connected", entityType: "IntegrationConnection", entityId: connectionId, after: auditView(row) });
      return summarise(row, null);
    });
  },

  /**
   * Sends the clearly-labelled test message and records the outcome (status CONNECTED or ERROR). The decrypted secret
   * exists only for the duration of the call, outside any transaction.
   */
  async test(actor: Actor, connectionId: string, deps: OutboundDeps & { env?: Record<string, string | undefined> } = {}): Promise<OperationResult> {
    assertHumanIntegrationManager(actor);
    const keyring = requireKeys(deps.env ?? process.env);
    const row = await withTenant(actor.organizationId, async (tx) => {
      const [found] = await tx
        .select()
        .from(integrationConnections)
        .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.organizationId, actor.organizationId)));
      return found;
    });
    if (!row) throw new IntegrationNotFoundError();
    const provider = getProvider(row.providerId);
    if (!provider) throw new InvalidIntegrationInputError("This integration is no longer available.");
    if (row.status === "DISCONNECTED" || !row.secretCiphertext) throw new InvalidIntegrationInputError("This connection is disconnected. Reconnect it first.");

    let result: OperationResult;
    try {
      const secrets = decryptSecrets(row.secretCiphertext, actor.organizationId, connectionId, keyring);
      result = await provider.testConnection({ organizationId: actor.organizationId, connectionId, config: { ...(row.config as object), ...secrets } }, deps);
    } catch (error) {
      result = { ok: false, message: error instanceof SecretDecryptionError ? "The stored secret could not be decrypted." : "The test could not be run.", errorClass: "secret_unavailable", statusCode: null };
    }

    const now = new Date();
    await withTenant(actor.organizationId, async (tx) => {
      await tx
        .update(integrationConnections)
        .set(
          result.ok
            ? { status: "CONNECTED", statusReason: null, lastError: null, consecutiveFailures: 0, lastCheckedAt: now, updatedAt: now }
            : { status: "ERROR", statusReason: sanitiseError(result.message), lastError: sanitiseError(result.message), lastCheckedAt: now, updatedAt: now },
        )
        .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.organizationId, actor.organizationId)));
      await appendEvent(tx, actor.organizationId, connectionId, { kind: "TEST", ok: result.ok, detail: result.message, errorClass: result.errorClass, statusCode: result.statusCode, actorUserId: actor.userId });
      await AuditService.record(tx, actor, {
        action: "integration.tested",
        entityType: "IntegrationConnection",
        entityId: connectionId,
        after: { ok: result.ok, errorClass: result.errorClass, statusCode: result.statusCode },
      });
    });
    return result;
  },

  /** Renames and/or toggles non-secret settings (for Slack: "include amounts"). Never touches the secret. */
  async updateSettings(actor: Actor, connectionId: string, input: { name?: string; settings?: Record<string, unknown> }): Promise<ConnectionSummary> {
    assertHumanIntegrationManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(integrationConnections)
        .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.organizationId, actor.organizationId)))
        .for("update");
      if (!row) throw new IntegrationNotFoundError();
      const before = auditView(row);
      const name = input.name === undefined ? row.name : cleanName(input.name);
      const config = { ...(row.config as Record<string, unknown>) };
      if (input.settings) {
        // Only keys the provider's PUBLIC config already has can be changed, and only to a boolean/short string: this cannot reach a secret.
        for (const [key, value] of Object.entries(input.settings)) {
          if (!(key in config) || key === "maskedUrl") continue;
          if (typeof value === "boolean") config[key] = value;
          else if (typeof value === "string" && value.length <= MAX_CONNECTION_NAME) config[key] = value.trim();
        }
      }
      const [updated] = await tx
        .update(integrationConnections)
        .set({ name, config, updatedAt: new Date() })
        .where(eq(integrationConnections.id, connectionId))
        .returning();
      if (!updated) throw new IntegrationNotFoundError();
      await AuditService.record(tx, actor, { action: "integration.settings_changed", entityType: "IntegrationConnection", entityId: connectionId, before, after: auditView(updated) });
      return summarise(updated, null);
    });
  },

  /** Replaces the stored secret (re-entering the webhook URL) and reconnects. The new secret is validated and vetted first. */
  async reconnect(
    actor: Actor,
    connectionId: string,
    config: unknown,
    deps: OutboundDeps & { env?: Record<string, string | undefined> } = {},
  ): Promise<ConnectionSummary> {
    assertHumanIntegrationManager(actor);
    const keyring = requireKeys(deps.env ?? process.env);
    const existing = await withTenant(actor.organizationId, async (tx) => {
      const [found] = await tx
        .select({ providerId: integrationConnections.providerId, config: integrationConnections.config })
        .from(integrationConnections)
        .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.organizationId, actor.organizationId)));
      return found;
    });
    if (!existing) throw new IntegrationNotFoundError();
    const provider = getProvider(existing.providerId);
    if (!provider) throw new InvalidIntegrationInputError("This integration is no longer available.");
    const validated = provider.validateConfig(config);
    if (!validated.ok) throw new InvalidIntegrationInputError(validated.message);
    const connected = await provider.connect({ organizationId: actor.organizationId, connectionId, config: validated.config }, deps);
    if (!connected.ok) throw new InvalidIntegrationInputError(connected.message);
    const encrypted = encryptSecrets(validated.secretConfig, actor.organizationId, connectionId, keyring);
    const now = new Date();
    return withTenant(actor.organizationId, async (tx) => {
      const [updated] = await tx
        .update(integrationConnections)
        .set({ config: validated.publicConfig, secretCiphertext: encrypted.ciphertext, secretKeyVersion: encrypted.keyVersion, status: "CONNECTED", statusReason: null, lastError: null, consecutiveFailures: 0, updatedAt: now })
        .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.organizationId, actor.organizationId)))
        .returning();
      if (!updated) throw new IntegrationNotFoundError();
      await appendEvent(tx, actor.organizationId, connectionId, { kind: "CONNECT", ok: true, detail: "Reconnected with a new credential.", actorUserId: actor.userId });
      await AuditService.record(tx, actor, { action: "integration.reconnected", entityType: "IntegrationConnection", entityId: connectionId, after: auditView(updated) });
      return summarise(updated, null);
    });
  },

  /** Disconnects: the stored secret is WIPED (set to NULL), the row and its log remain. Works with no encryption key. */
  async disconnect(actor: Actor, connectionId: string): Promise<void> {
    assertHumanIntegrationManager(actor);
    await withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(integrationConnections)
        .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.organizationId, actor.organizationId)))
        .for("update");
      if (!row) throw new IntegrationNotFoundError();
      await tx
        .update(integrationConnections)
        .set({ status: "DISCONNECTED", statusReason: "Disconnected by a person.", secretCiphertext: null, secretKeyVersion: null, updatedAt: new Date() })
        .where(eq(integrationConnections.id, connectionId));
      await appendEvent(tx, actor.organizationId, connectionId, { kind: "DISCONNECT", ok: true, detail: "Disconnected; the stored credential was erased.", actorUserId: actor.userId });
      await AuditService.record(tx, actor, { action: "integration.disconnected", entityType: "IntegrationConnection", entityId: connectionId, before: auditView(row), after: { status: "DISCONNECTED" } });
    });
  },

  /** Deletes a DISCONNECTED connection (and, by cascade, its log). A connected one must be disconnected first. */
  async remove(actor: Actor, connectionId: string): Promise<void> {
    assertHumanIntegrationManager(actor);
    await withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(integrationConnections)
        .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.organizationId, actor.organizationId)))
        .for("update");
      if (!row) throw new IntegrationNotFoundError();
      if (row.status !== "DISCONNECTED") throw new InvalidIntegrationInputError("Disconnect the connection before removing it.");
      await tx.delete(integrationConnections).where(eq(integrationConnections.id, connectionId));
      await AuditService.record(tx, actor, { action: "integration.removed", entityType: "IntegrationConnection", entityId: connectionId, before: auditView(row) });
    });
  },

  // ---- used by the automation engine (inside ITS transactions) ---------------------------------------------------------

  /**
   * Reads what a send needs, inside the CALLER's transaction: the connection must exist in this organization, be CONNECTED,
   * and belong to a provider that declares the `send` capability. Returns the ciphertext (decrypted later, outside any
   * transaction), never a plaintext secret.
   */
  async prepareSendIn(tx: TenantDb, organizationId: string, connectionId: string): Promise<PrepareSendResult> {
    const [row] = await tx
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.organizationId, organizationId)));
    if (!row) return { ok: false, reason: "The channel this rule sends to no longer exists." };
    const provider = getProvider(row.providerId);
    if (!provider || !provider.capabilities.includes("send") || !provider.send) return { ok: false, reason: "That integration cannot send messages." };
    if (row.status !== "CONNECTED" || !row.secretCiphertext) return { ok: false, reason: `The channel "${row.name}" is not connected (${row.status.toLowerCase()}).` };
    return { ok: true, plan: { connectionId: row.id, providerId: row.providerId, config: row.config as Record<string, unknown>, secretCiphertext: row.secretCiphertext } };
  },

  /** Decrypts and sends. Pure I/O: it opens NO transaction. Never throws. */
  async sendWithPlan(organizationId: string, plan: SendPlan, message: ChannelMessage, deps: OutboundDeps & { env?: Record<string, string | undefined> } = {}): Promise<OperationResult> {
    try {
      const provider = getProvider(plan.providerId);
      if (!provider?.send) return { ok: false, message: "That integration cannot send messages.", errorClass: "unsupported", statusCode: null };
      const keyring = loadKeyring(deps.env ?? process.env);
      if (!keyring.ok) return { ok: false, message: `Integrations are disabled: ${keyring.reason}`, errorClass: "encryption_unavailable", statusCode: null };
      const secrets = decryptSecrets(plan.secretCiphertext, organizationId, plan.connectionId, keyring.keyring);
      return await provider.send({ organizationId, connectionId: plan.connectionId, config: { ...plan.config, ...secrets } }, message, deps);
    } catch (error) {
      if (error instanceof SecretDecryptionError || error instanceof SecretEncryptionUnavailableError) return { ok: false, message: "The stored secret could not be decrypted.", errorClass: "secret_unavailable", statusCode: null };
      return { ok: false, message: "The message could not be sent.", errorClass: "network", statusCode: null };
    }
  },

  /** Records a send outcome inside the CALLER's transaction: the log row, the failure counter and (after repeated failures) the ERROR status. */
  async recordSendIn(tx: TenantDb, actor: Actor, connectionId: string, result: OperationResult, ruleId: string, now: Date = new Date()): Promise<void> {
    const organizationId = actor.organizationId;
    await appendEvent(tx, organizationId, connectionId, { kind: "SEND", ok: result.ok, detail: result.message, errorClass: result.errorClass, statusCode: result.statusCode, ruleId });
    if (result.ok) {
      await tx
        .update(integrationConnections)
        .set({ consecutiveFailures: 0, lastError: null, lastCheckedAt: now })
        .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.organizationId, organizationId)));
      return;
    }
    const [row] = await tx
      .update(integrationConnections)
      .set({ consecutiveFailures: sql`${integrationConnections.consecutiveFailures} + 1`, lastError: sanitiseError(result.message), lastCheckedAt: now })
      .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.organizationId, organizationId)))
      .returning({ failures: integrationConnections.consecutiveFailures, status: integrationConnections.status, name: integrationConnections.name });
    if (row && row.status === "CONNECTED" && row.failures >= CONNECTION_ERROR_AFTER_FAILURES) {
      const reason = `Set to ERROR after ${row.failures} consecutive failed sends. Test the connection to restore it.`;
      await tx
        .update(integrationConnections)
        .set({ status: "ERROR", statusReason: reason, updatedAt: now })
        .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.organizationId, organizationId)));
      await appendEvent(tx, organizationId, connectionId, { kind: "ERROR", ok: false, detail: reason });
      await AuditService.record(tx, actor, {
        action: "integration.error_flagged",
        entityType: "IntegrationConnection",
        entityId: connectionId,
        before: { status: "CONNECTED" },
        after: { status: "ERROR", statusReason: reason, consecutiveFailures: row.failures },
      });
    }
  },
};
