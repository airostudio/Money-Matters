import { Pool } from "pg";
import { closeDatabase, db } from "@/db/client";
import { eq } from "drizzle-orm";
import { organizations, users } from "@/db/schema";
import { OrganizationService } from "@/domain/organizations/organization-service";
import type { Actor } from "@/domain/permissions/permission-service";
import type { MembershipRole } from "@/domain/permissions/roles";

const TENANT_TABLES = [
  "entity_group_audit_logs",
  "entity_group_adjustment_lines",
  "entity_group_adjustments",
  "entity_group_intercompany_accounts",
  "entity_group_account_mappings",
  "entity_group_accounts",
  "entity_group_members",
  "entity_groups",
  "platform_admin_audit_logs",
  "period_lock_events",
  "close_signoffs",
  "period_closes",
  "scenarios",
  "cash_forecast_settings",
  "budget_lines",
  "budgets",
  "pay_run_lines",
  "pay_runs",
  "employees",
  "depreciation_entries",
  "fixed_assets",
  "fixed_asset_classes",
  "inventory_movements",
  "inventory_adjustments",
  "products",
  "timesheet_entries",
  "project_tasks",
  "projects",
  "ai_auto_executions",
  "ai_auto_approved_actions",
  "ai_draft_proposals",
  "saved_reports",
  "audit_logs",
  "expense_claim_lines",
  "expense_claims",
  "uploaded_receipts",
  "payment_run_items",
  "payment_runs",
  "supplier_credit_allocations",
  "supplier_credit_note_lines",
  "supplier_credit_notes",
  "bill_recurring_source",
  "recurring_bill_template_lines",
  "recurring_bill_templates",
  "purchase_order_receipt_lines",
  "purchase_order_receipts",
  "purchase_order_lines",
  "purchase_orders",
  "supplier_payment_allocations",
  "supplier_payments",
  "bill_lines",
  "bills",
  "invoice_recurring_source",
  "recurring_invoice_template_lines",
  "recurring_invoice_templates",
  "quote_lines",
  "quotes",
  "payment_allocations",
  "payments",
  "invoice_lines",
  "invoices",
  "bank_transactions",
  "bank_import_batches",
  "bank_rules",
  "bank_accounts",
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
  adminPool = undefined;
  await closeDatabase();
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
  options: { seatLimit?: number } = {},
): Promise<{ organizationId: string; owner: Actor; baseCurrency: string }> {
  const user = await createTestUser("Owner");
  const org = await OrganizationService.createWithOwner(user.id, {
    slug: `${slugPrefix}-${testUserCounter}-${Date.now()}`,
    name: `${slugPrefix} ${testUserCounter}`,
    baseCurrency: "AUD",
  });

  // Real organizations default to 2 seats (see the seat-limit tests); most
  // fixtures need several members (creator, approver, reviewer, ...), so
  // they get headroom unless a test asks for a specific limit.
  await db
    .update(organizations)
    .set({ seatLimit: options.seatLimit ?? 50 })
    .where(eq(organizations.id, org.id));

  return {
    organizationId: org.id,
    owner: { userId: user.id, organizationId: org.id, role: "OWNER" },
    baseCurrency: org.baseCurrency,
  };
}

export function actorWithRole(actor: Actor, role: Actor["role"]): Actor {
  return { ...actor, role };
}

/**
 * Adds a second, distinct user as a member of the same organization as
 * `ownerActor` and returns a ready-to-use Actor for them — for tests that
 * need two genuinely different users in one org, e.g. payment run
 * segregation of duties (creator ≠ approver).
 */
export async function addTestMember(ownerActor: Actor, role: MembershipRole, namePrefix = "Member"): Promise<Actor> {
  const user = await createTestUser(namePrefix);
  await OrganizationService.addMemberByEmail(ownerActor, user.email, role);
  return { userId: user.id, organizationId: ownerActor.organizationId, role };
}
