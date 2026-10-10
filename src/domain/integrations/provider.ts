import type { ZodType, ZodTypeDef } from "zod";
import type { OutboundDeps } from "@/domain/webhooks/outbound";

/**
 * The integration framework's provider-adapter abstraction (master spec s.53: "Create an integration framework").
 *
 * A provider is a small, stateless adapter. It declares WHAT it is (id, name, category, capabilities), WHAT it needs
 * (a zod config schema and which fields are secrets) and HOW to talk to the other side (connect / test / disconnect, and
 * optionally send / handleDomainEvent). It never touches the database, never sees another organization's data and never
 * handles encryption: the connection service owns persistence, the encryption key and the audit trail, decrypts a
 * connection's secrets just in time, and hands the provider a context. That is what lets Basiq/Plaid, Stripe, Shopify,
 * HubSpot, Gmail/Outlook, Drive/OneDrive or Teams plug in later without reworking the platform.
 *
 * Only providers that REALLY work are `IntegrationProvider`s. Everything else in the catalogue is a
 * `ComingSoonProvider` descriptor with no behaviour at all (see catalog.ts) - there are deliberately no stub connectors
 * that pretend to work.
 */
export const INTEGRATION_CATEGORIES = ["BANKING", "PAYMENTS", "ECOMMERCE", "CRM", "PAYROLL_HR", "PRODUCTIVITY", "MESSAGING", "STORAGE"] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  BANKING: "Banking",
  PAYMENTS: "Payments",
  ECOMMERCE: "E-commerce",
  CRM: "CRM",
  PAYROLL_HR: "Payroll and HR",
  PRODUCTIVITY: "Email and productivity",
  MESSAGING: "Messaging",
  STORAGE: "File storage",
};

/** What a provider can do. `send` = it can deliver a message to the outside; `receive_events` = it can consume domain events; `sync` = it can pull data. */
export type IntegrationCapability = "send" | "receive_events" | "sync";

export type ConnectionStatus = "CONNECTED" | "ERROR" | "DISCONNECTED";

/** A short message for a channel. Deliberately tiny: plain text pieces, never raw ledger data. */
export interface ChannelMessage {
  title: string;
  body: string | null;
  /** Absolute https URL back to the relevant Money Matters page, or null. */
  linkUrl: string | null;
  severity: "INFO" | "ACTION" | "WARNING" | "CRITICAL";
  /** An already-formatted amount line ("Total 120.00 AUD"). A provider adds it ONLY if its connection opted in to amounts. */
  amountLine: string | null;
}

export interface ProviderContext<TConfig> {
  organizationId: string;
  connectionId: string;
  /** Non-secret settings merged with the connection's decrypted secrets (decrypted just in time, never persisted in this form). */
  config: TConfig;
}

export interface OperationResult {
  ok: boolean;
  /** A short, safe message for the person ("Slack accepted the message."). Never contains a secret. */
  message: string;
  /** ssrf_blocked, dns, redirect, http_error, timeout, tls, connect, ... or null. */
  errorClass: string | null;
  statusCode: number | null;
}

export type ValidatedConfig<TConfig> =
  | {
      ok: true;
      config: TConfig;
      /** Safe to store in the clear and show: includes a MASKED rendering of any secret, never the secret. */
      publicConfig: Record<string, unknown>;
      /** The secret fields, as name -> value, to be encrypted. */
      secretConfig: Record<string, string>;
    }
  | { ok: false; message: string };

export interface DomainEventForProvider {
  id: string;
  type: string;
  payload: unknown;
}

export interface IntegrationProvider<TConfig = Record<string, unknown>> {
  readonly id: string;
  readonly name: string;
  readonly category: IntegrationCategory;
  readonly description: string;
  readonly capabilities: readonly IntegrationCapability[];
  /** Validates the whole config as entered (secrets included). */
  readonly configSchema: ZodType<TConfig, ZodTypeDef, unknown>;
  /** Names of the config fields that are secrets (encrypted at rest, never returned, never logged, never audited). */
  readonly secretFields: readonly string[];

  /** Pure, synchronous validation + split into public / secret parts. No network. */
  validateConfig(input: unknown): ValidatedConfig<TConfig>;
  /** Checks the config can be used from here (for a URL-based provider: the SSRF guard incl. DNS). Sends nothing to the third party. */
  connect(ctx: ProviderContext<TConfig>, deps?: OutboundDeps): Promise<OperationResult>;
  /** Proves the connection works end to end (for a channel: a clearly labelled test message). */
  testConnection(ctx: ProviderContext<TConfig>, deps?: OutboundDeps): Promise<OperationResult>;
  /** Provider-side clean-up on disconnect. The framework wipes the stored secret regardless. */
  disconnect(ctx: Omit<ProviderContext<TConfig>, "config">): Promise<void>;
  /** Optional: consume a domain event (v1 has no provider that does; the hook exists so one can plug in). */
  handleDomainEvent?(ctx: ProviderContext<TConfig>, event: DomainEventForProvider, deps?: OutboundDeps): Promise<OperationResult>;
  /** Optional: deliver a message. Present exactly when `capabilities` includes "send". */
  send?(ctx: ProviderContext<TConfig>, message: ChannelMessage, deps?: OutboundDeps): Promise<OperationResult>;
}

/** A catalogue entry for something that is NOT built. It has no behaviour; it exists so the UI can say honestly what is coming and what it needs. */
export interface ComingSoonProvider {
  readonly id: string;
  readonly name: string;
  readonly category: IntegrationCategory;
  readonly description: string;
  readonly availability: "COMING_SOON";
  /** Why it is not available yet, in plain words (credentials, an OAuth app, a partner agreement...). */
  readonly needs: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  availability: "AVAILABLE" | "COMING_SOON";
  capabilities: readonly IntegrationCapability[];
  /** For COMING_SOON entries. */
  needs: string | null;
}
