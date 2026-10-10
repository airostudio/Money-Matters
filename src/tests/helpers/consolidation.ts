import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { organizations } from "@/db/schema";
import { AccountService, type AccountType } from "@/domain/accounts/account-service";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { OrganizationService } from "@/domain/organizations/organization-service";
import type { Actor } from "@/domain/permissions/permission-service";
import type { MembershipRole } from "@/domain/permissions/roles";
import { GroupService } from "@/domain/consolidation/group-service";
import type { GroupActor } from "@/domain/consolidation/entity-access";
import { createTestOrg, createTestUser } from "./db";

export type OrgKey = "A" | "B" | "C" | "D";

const CHART: Array<{ code: string; name: string; type: AccountType }> = [
  { code: "1000", name: "Cash at Bank", type: "ASSET" },
  { code: "1500", name: "Intercompany Loan Receivable", type: "ASSET" },
  { code: "2500", name: "Intercompany Loan Payable", type: "LIABILITY" },
  { code: "4000", name: "Sales", type: "REVENUE" },
  { code: "4100", name: "Intercompany Revenue", type: "REVENUE" },
  { code: "6000", name: "General Expenses", type: "EXPENSE" },
  { code: "6100", name: "Intercompany Expense", type: "EXPENSE" },
];

export interface EntityWorld {
  key: OrgKey;
  organizationId: string;
  name: string;
  slug: string;
  /** The organization's own OWNER (a different person from the consolidating user, except in A). */
  ownerActor: Actor;
  /** Real account ids, by code. */
  accountIds: Record<string, string>;
  bankAccountId: string;
}

export interface ConsolidationWorld {
  user: { id: string; email: string };
  groupActor: GroupActor;
  entities: Record<OrgKey, EntityWorld>;
  /** The consolidating user's Actor in an entity, at their CURRENT role there. */
  actorIn(key: OrgKey, role: MembershipRole): Actor;
  /** Changes the consolidating user's role in an entity (done by that entity's own owner). */
  setUserRole(key: OrgKey, role: MembershipRole): Promise<void>;
  /** Removes the consolidating user from an entity (done by that entity's own owner). */
  removeUser(key: OrgKey): Promise<void>;
}

async function membershipIdOf(owner: Actor, userId: string): Promise<string> {
  const members = await OrganizationService.listMembers(owner);
  const row = members.find((m) => m.userId === userId);
  if (!row) throw new Error("membership not found");
  return row.membershipId;
}

async function seedChart(owner: Actor, currency: string) {
  const ids: Record<string, string> = {};
  for (const def of CHART) {
    const a = await AccountService.create(owner, { ...def, currency });
    ids[def.code] = a.id;
  }
  return ids;
}

async function post(owner: Actor, date: string, dr: string, cr: string, amount: string, memo?: string) {
  await PostingService.postJournal(owner, {
    postingDate: new Date(date),
    memo,
    lines: [
      { accountId: dr, debit: amount, currency: "AUD" },
      { accountId: cr, credit: amount, currency: "AUD" },
    ],
  });
}

/**
 * Four organizations and one consolidating user, with the exact mix the slice's
 * acceptance tests need: OWNER in A, ACCOUNTANT in B, READ_ONLY in C, and NOT a
 * member of D. Each organization has an identical small chart of accounts and a
 * linked bank account, and distinctive, hand-checkable postings:
 *
 *   A (user OWNER)      cash +60,000 (capital), loan to B -10,000 (IC loan receivable +10,000), sales +5,000
 *   B (user ACCOUNTANT) cash +10,000 (IC loan payable +10,000), sales +2,000, expenses -800
 *   C (user READ_ONLY)  cash +7,000 (capital)
 *   D (not a member)    cash +99,999 (capital) — a number that must never appear for this user
 *
 * The user is an OWNER everywhere while the group is being built (so adding
 * entities is allowed) — tests then lower or remove the user's role with
 * `setUserRole` / `removeUser`, the way a real change of access happens.
 */
export async function createConsolidationWorld(options: { seedLedgers?: boolean } = {}): Promise<ConsolidationWorld> {
  const seed = options.seedLedgers ?? true;
  const user = await createTestUser("Consolidator");
  const groupActor: GroupActor = { userId: user.id };

  // A: created BY the consolidating user, so they are its OWNER.
  const orgA = await OrganizationService.createWithOwner(user.id, { slug: `entity-a-${Date.now()}`, name: "Entity A", baseCurrency: "AUD" });
  await db.update(organizations).set({ seatLimit: 50 }).where(eq(organizations.id, orgA.id));
  const ownerA: Actor = { userId: user.id, organizationId: orgA.id, role: "OWNER" };

  const entities = {} as Record<OrgKey, EntityWorld>;
  entities.A = {
    key: "A",
    organizationId: orgA.id,
    name: orgA.name,
    slug: orgA.slug,
    ownerActor: ownerA,
    accountIds: {},
    bankAccountId: "",
  };

  for (const key of ["B", "C", "D"] as const) {
    const created = await createTestOrg(`entity-${key.toLowerCase()}`);
    const org = (await db.select().from(organizations).where(eq(organizations.id, created.organizationId)))[0]!;
    entities[key] = {
      key,
      organizationId: created.organizationId,
      name: org.name,
      slug: org.slug,
      ownerActor: created.owner,
      accountIds: {},
      bankAccountId: "",
    };
    // The consolidating user joins as OWNER for now (see the doc comment).
    await OrganizationService.addMemberByEmail(created.owner, user.email, "OWNER");
  }

  for (const key of ["A", "B", "C", "D"] as const) {
    const e = entities[key];
    e.accountIds = await seedChart(e.ownerActor, "AUD");
    const bank = await BankAccountService.create(e.ownerActor, {
      name: `${e.name} Operating`,
      glAccountId: e.accountIds["1000"]!,
      currency: "AUD",
    });
    e.bankAccountId = bank.id;
  }

  if (seed) {
    const a = entities.A;
    const b = entities.B;
    const c = entities.C;
    const d = entities.D;
    const equityOf = async (e: EntityWorld) => {
      const accounts = await AccountService.list(e.ownerActor);
      return accounts.find((x) => x.code === "3000")!.id; // the starter "Opening Balance Equity" account
    };
    await post(a.ownerActor, "2026-01-02", a.accountIds["1000"]!, await equityOf(a), "60000.00", "Capital");
    await post(a.ownerActor, "2026-01-15", a.accountIds["1500"]!, a.accountIds["1000"]!, "10000.00", "Loan to B");
    await post(a.ownerActor, "2026-02-01", a.accountIds["1000"]!, a.accountIds["4000"]!, "5000.00", "Sales");

    await post(b.ownerActor, "2026-01-15", b.accountIds["1000"]!, b.accountIds["2500"]!, "10000.00", "Loan from A");
    await post(b.ownerActor, "2026-02-01", b.accountIds["1000"]!, b.accountIds["4000"]!, "2000.00", "Sales");
    await post(b.ownerActor, "2026-02-10", b.accountIds["6000"]!, b.accountIds["1000"]!, "800.00", "Expenses");

    await post(c.ownerActor, "2026-01-02", c.accountIds["1000"]!, await equityOf(c), "7000.00", "Capital");
    await post(d.ownerActor, "2026-01-02", d.accountIds["1000"]!, await equityOf(d), "99999.00", "Capital");
  }

  return {
    user,
    groupActor,
    entities,
    actorIn: (key, role) => ({ userId: user.id, organizationId: entities[key].organizationId, role }),
    async setUserRole(key, role) {
      const owner = entities[key].ownerActor;
      const membershipId = await membershipIdOf(owner, user.id);
      await OrganizationService.updateMemberRole(owner, membershipId, role);
    },
    async removeUser(key) {
      const owner = entities[key].ownerActor;
      const membershipId = await membershipIdOf(owner, user.id);
      await OrganizationService.removeMember(owner, membershipId);
    },
  };
}

/** A group containing A (parent), B, C and D, built while the user is OWNER everywhere. */
export async function createFullGroup(world: ConsolidationWorld, name = "Test Group") {
  const group = await GroupService.create(world.groupActor, { name });
  for (const key of ["A", "B", "C", "D"] as const) {
    await GroupService.addEntity(world.groupActor, group.id, world.entities[key].organizationId);
  }
  return group;
}
