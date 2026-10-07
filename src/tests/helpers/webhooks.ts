import { and, asc, eq } from "drizzle-orm";
import { domainEvents } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { Actor } from "@/domain/permissions/permission-service";
import type { Resolver } from "@/domain/webhooks/url-guard";
import type { Transport, TransportRequest, TransportResponse } from "@/domain/webhooks/outbound";
import { WebhookSubscriptionService } from "@/domain/webhooks/subscription-service";

/** A fixed, valid 32-byte key for tests (the real one is random and lives only in the environment). */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 0x5a).toString("base64");

export function enableWebhookEncryption(): void {
  process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION;
}

export function disableWebhookEncryption(): void {
  delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
}

/** A globally routable address (example.com's), used as the "public" DNS answer. */
export const PUBLIC_IP = "93.184.216.34";

/** Resolver answering every host with `PUBLIC_IP` unless a table says otherwise. */
export function fakeResolver(table: Record<string, string[]> = {}): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const resolver = (async (hostname: string) => {
    calls.push(hostname);
    const addresses = table[hostname] ?? [PUBLIC_IP];
    return addresses.map((address) => ({ address, family: (address.includes(":") ? 6 : 4) as 4 | 6 }));
  }) as Resolver & { calls: string[] };
  resolver.calls = calls;
  return resolver;
}

export type Responder = (request: TransportRequest, callNumber: number) => TransportResponse | Promise<TransportResponse>;

/** A fake HTTP client: records every request it is asked to make, answers via `responder` (default 200 OK). */
export function fakeTransport(responder: Responder = () => ({ status: 200, bodyExcerpt: Buffer.from("ok") })): Transport & { calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const transport = (async (request: TransportRequest) => {
    calls.push(request);
    return responder(request, calls.length);
  }) as Transport & { calls: TransportRequest[] };
  transport.calls = calls;
  return transport;
}

export async function eventsOf(organizationId: string, type?: string) {
  return withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(domainEvents)
      .where(type ? and(eq(domainEvents.organizationId, organizationId), eq(domainEvents.type, type)) : eq(domainEvents.organizationId, organizationId))
      .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id)),
  );
}

export async function makeSubscription(
  actor: Actor,
  options: { url?: string; eventTypes?: string[]; description?: string } = {},
  resolver: Resolver = fakeResolver(),
) {
  return WebhookSubscriptionService.create(
    actor,
    { url: options.url ?? "https://hooks.example.com/mm", eventTypes: options.eventTypes ?? ["invoice.created", "invoice.paid", "payment.received", "bill.created", "bill.approved", "customer.created", "supplier.created", "invoice.sent"], description: options.description },
    { resolver },
  );
}
