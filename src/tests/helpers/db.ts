import { Pool } from "pg";
import { db, pool } from "@/db/client";
import { users } from "@/db/schema";
import { OrganizationService } from "@/domain/organizations/organization-service";
import type { Actor } from "@/domain/permissions/permission-service";

const TENANT_TABLES = [
  "audit_logs",
  "journal_line_dimensions",
  "journal_lines",
  "journal_entries",
  "approvals",
  "dimension_values",
  "dimensions",
  "tax_codes",
  "exchange_rates",
  "fiscal_periods",
  "accounts",
  "contacts",
  "organization_memberships",
  "organizations",
  "users",
];

let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
  return adminPool;
}

/** Wipes every table between tests. Uses the superuser connection — mm_app owns nothing and can't TRUNCATE. */
export async function resetDatabase(): Promise<void> {
  await admin().query(`TRUNCATE TABLE ${TENANT_TABLES.join(", ")} RESTART IDENTITY CASCADE;`);
}

export async function closeTestPools(): Promise<void> {
  await adminPool?.end();
  await pool.end();
}

let testUserCounter = 0;

export async function createTestUser(namePrefix = "Test User"): Promise<{ id: string; email: string }> {
  testUserCounter += 1;
  const email = `${namePrefix.toLowerCase().replace(/\s+/g, ".")}.${testUserCounter}@example.test`;
  const [user] = await db.insert(users).values({ email, name: namePrefix }).returning();
  if (!user) throw new Error("Failed to create test user.");
  return { id: user.id, email: user.email };
}

/** Creates a fresh organization with an OWNER user and returns a ready-to-use Actor. */
export async function createTestOrg(
  slugPrefix = "test-org",
): Promise<{ organizationId: string; owner: Actor; baseCurrency: string }> {
  const user = await createTestUser("Owner");
  const org = await OrganizationService.createWithOwner(user.id, {
    slug: `${slugPrefix}-${testUserCounter}-${Date.now()}`,
    name: `${slugPrefix} ${testUserCounter}`,
    baseCurrency: "AUD",
  });

  return {
    organizationId: org.id,
    owner: { userId: user.id, organizationId: org.id, role: "OWNER" },
    baseCurrency: org.baseCurrency,
  };
}

export function actorWithRole(actor: Actor, role: Actor["role"]): Actor {
  return { ...actor, role };
}
