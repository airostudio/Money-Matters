import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { oauthClientIndex } from "@/db/schema";
import { isClientId } from "./credentials";

/**
 * The single non-tenant query that turns a presented `client_id` into the organisation to open. Everything else about
 * the client (is it disabled? its redirect URIs, scopes and secret hash) is read from the RLS-protected `oauth_apps` row
 * once that organisation's tenant transaction is open - the index row is immutable by design.
 *
 * A malformed id never reaches the database.
 */
export interface ClientIndexRow {
  appId: string;
  organizationId: string;
  clientType: "PUBLIC" | "CONFIDENTIAL";
}

export async function lookupClient(clientId: string): Promise<ClientIndexRow | null> {
  if (!isClientId(clientId)) return null;
  const [row] = await db
    .select({ appId: oauthClientIndex.id, organizationId: oauthClientIndex.organizationId, clientType: oauthClientIndex.clientType })
    .from(oauthClientIndex)
    .where(eq(oauthClientIndex.clientId, clientId))
    .limit(1);
  return row ?? null;
}
