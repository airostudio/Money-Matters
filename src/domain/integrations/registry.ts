import { COMING_SOON_PROVIDERS } from "./catalog";
import type { CatalogEntry, IntegrationCapability, IntegrationProvider } from "./provider";
import { slackIncomingWebhookProvider } from "./providers/slack-incoming-webhook";

/**
 * The provider registry: the ONLY place a provider becomes usable. `getProvider` returns an implementation or nothing -
 * a catalogue "coming soon" entry never resolves to one, so no code path can connect or send through a provider that does
 * not exist. Adding a real provider is: implement `IntegrationProvider`, add it here, remove its catalogue entry.
 */
const IMPLEMENTED: readonly IntegrationProvider<any>[] = [slackIncomingWebhookProvider];

const byId = new Map(IMPLEMENTED.map((p) => [p.id, p]));

export function getProvider(id: string): IntegrationProvider<any> | undefined {
  return byId.get(id);
}

export function hasCapability(id: string, capability: IntegrationCapability): boolean {
  return getProvider(id)?.capabilities.includes(capability) ?? false;
}

/** Implemented providers first, then everything that is coming soon - each labelled for what it is. */
export function listCatalog(): CatalogEntry[] {
  const available: CatalogEntry[] = IMPLEMENTED.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    description: p.description,
    availability: "AVAILABLE",
    capabilities: p.capabilities,
    needs: null,
  }));
  const soon: CatalogEntry[] = COMING_SOON_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    description: p.description,
    availability: "COMING_SOON",
    capabilities: [],
    needs: p.needs,
  }));
  return [...available, ...soon];
}

export function isComingSoon(id: string): boolean {
  return COMING_SOON_PROVIDERS.some((p) => p.id === id);
}
