import { createSalesFixtures } from "./sales";
import type { Actor } from "@/domain/permissions/permission-service";

let fixtureCounter = 0;

/**
 * A ready-to-use customer + AR/revenue/tax chart of accounts for project
 * tests — reuses `createSalesFixtures` since "create an invoice from
 * unbilled time" goes through the exact same `InvoiceService.create` path
 * as any other sales invoice.
 */
export async function createProjectFixtures(actor: Actor, currency: string) {
  fixtureCounter += 1;
  const sales = await createSalesFixtures(actor, currency);
  return { ...sales, projectCodeSuffix: String(fixtureCounter).padStart(2, "0") };
}
