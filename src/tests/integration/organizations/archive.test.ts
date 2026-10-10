import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import pg from "pg";

// Sessions are mocked at the NextAuth boundary only; the DB-backed identity lookup, the session helpers, the layout,
// the pages, the actions and every service below are real.
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: () => new Headers({ "x-forwarded-for": "203.0.113.9" }) }));

import { getServerSession } from "next-auth";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import {
  apiKeys,
  auditLogs,
  domainEvents,
  journalEntries,
  journalLines,
  organizationMemberships,
  organizations,
  platformAdminAuditLogs,
  webhookSubscriptions,
} from "@/db/schema";
import { UserService } from "@/domain/auth/user-service";
import { OrganizationService, SlugTakenError } from "@/domain/organizations/organization-service";
import { OrganizationLifecycleService } from "@/domain/organizations/lifecycle-service";
import {
  ArchiveConfirmationError,
  ArchiveNotPermittedError,
  InvalidArchiveReasonError,
  OrganizationAlreadyArchivedError,
  OrganizationArchivedError,
  OrganizationNotArchivedError,
} from "@/domain/organizations/archive-rules";
import { PlatformAdminService } from "@/domain/platform-admin/platform-admin-service";
import { PlatformAdminRequiredError } from "@/domain/platform-admin/identity";
import { DirectoryService } from "@/domain/platform-admin/directory-service";
import { MetricsService } from "@/domain/platform-admin/metrics-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { NotAMemberError, getActorForOrganization, requireActor, requireOrgAndActor } from "@/lib/session";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { AutonomySettingsService } from "@/domain/ai-controller/autonomy";
import { AutoApprovedActionsService } from "@/domain/ai-controller/auto-execution-policy";
import { AutoExecutionService } from "@/domain/ai-controller/auto-execution-service";
import { RecurringInvoiceService } from "@/domain/sales/recurring-invoice-service";
import { RecurringBillService } from "@/domain/purchases/recurring-bill-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { WebhookDispatchService } from "@/domain/webhooks/dispatch-service";
import { configurePostResponseDispatch, scheduleDispatchAfterResponse } from "@/domain/webhooks/post-response";
import { pendingSummary } from "@/domain/webhooks/delivery-queries";
import { HealthService } from "@/domain/practice/health-service";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { ProposalNotPossibleError, NotAClientMemberError } from "@/domain/practice/errors";
import { requireClientActor } from "@/domain/practice/client-access";
import { ConsolidationService } from "@/domain/consolidation/consolidation-service";
import { GroupService } from "@/domain/consolidation/group-service";
import * as settingsActions from "@/app/[orgSlug]/settings/actions";
import * as salesActions from "@/app/[orgSlug]/sales/actions";
import AppLandingPage from "@/app/app/page";
import OrgLayout from "@/app/[orgSlug]/layout";
import { ArchivedCompanyNotice } from "@/components/shell/archived-company";
import { restoreCompanyAction } from "@/app/app/actions";
import { call, makeKey, resetApiThrottle } from "../../helpers/api";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { createSampleAccounts } from "../../helpers/ledger";
import { enableWebhookEncryption, fakeResolver, fakeTransport, makeSubscription } from "../../helpers/webhooks";
import { createPracticeWorld } from "../../helpers/practice";
import { createConsolidationWorld, createFullGroup } from "../../helpers/consolidation";
import { actorWithRole, addTestMember, closeTestPools, createTestOrg, createTestUser, resetDatabase } from "../../helpers/db";

const ADMIN_EMAIL = "typhoon.tall69@gmail.com";
const originalAdminEnv = process.env.PLATFORM_ADMIN_EMAILS;
const mockedSession = vi.mocked(getServerSession);
const signInAs = (userId: string | null) => mockedSession.mockResolvedValue(userId ? ({ user: { id: userId } } as never) : null);

async function nameOf(organizationId: string) {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  return row!;
}
async function slugOf(organizationId: string) {
  return (await nameOf(organizationId)).slug;
}
async function archiveAsOwner(owner: Actor, reason = "Closing for the season") {
  return OrganizationLifecycleService.archive(owner, { confirmName: (await nameOf(owner.organizationId)).name, acknowledged: true, reason });
}
async function auditRows(organizationId: string) {
  return withTenant(organizationId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, organizationId)));
}
/** Flattens a rendered React element tree into text plus `prop=value` strings (JSON.stringify chokes on React's owner links). */
function textOf(node: unknown, seen = new Set<unknown>()): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => textOf(n, seen)).join(" ");
  if (typeof node === "object") {
    if (seen.has(node)) return "";
    seen.add(node);
    const props = (node as { props?: Record<string, unknown> }).props;
    if (!props) return "";
    return Object.entries(props)
      .map(([k, v]) => (typeof v === "string" ? `${k}=${v}` : textOf(v, seen)))
      .join(" ");
  }
  return "";
}
async function redirectTarget(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: { digest?: string }) => e,
  );
  const digest = error?.digest ?? "";
  expect(digest.startsWith("NEXT_REDIRECT"), `expected a redirect, got ${digest || String(error)}`).toBe(true);
  return digest.split(";")[2] ?? "";
}

describe("Organisation archive: reversible, owner/admin only, closed through every path", () => {
  let org: Awaited<ReturnType<typeof createTestOrg>>;
  let admin: { id: string; email: string };

  afterAll(closeTestPools);

  beforeEach(async () => {
    await resetDatabase();
    resetApiThrottle();
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    admin = await UserService.register({ email: ADMIN_EMAIL, name: "Admin", password: "password123" });
    org = await createTestOrg("archive-me", { seatLimit: 5 });
  });

  afterEach(() => {
    if (originalAdminEnv === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = originalAdminEnv;
    mockedSession.mockReset();
    configurePostResponseDispatch(null);
  });

  describe("archiving as the company's OWNER", () => {
    it("needs the exact company name, the acknowledgement and a reason - and a refusal changes nothing", async () => {
      const name = (await nameOf(org.organizationId)).name;
      const good = { confirmName: name, acknowledged: true, reason: "Closing for the season" };
      await expect(OrganizationLifecycleService.archive(org.owner, { ...good, confirmName: name.toUpperCase() })).rejects.toBeInstanceOf(ArchiveConfirmationError);
      await expect(OrganizationLifecycleService.archive(org.owner, { ...good, confirmName: `${name} x` })).rejects.toBeInstanceOf(ArchiveConfirmationError);
      await expect(OrganizationLifecycleService.archive(org.owner, { ...good, confirmName: "" })).rejects.toBeInstanceOf(ArchiveConfirmationError);
      await expect(OrganizationLifecycleService.archive(org.owner, { ...good, acknowledged: false })).rejects.toBeInstanceOf(ArchiveConfirmationError);
      await expect(OrganizationLifecycleService.archive(org.owner, { ...good, reason: "no" })).rejects.toBeInstanceOf(InvalidArchiveReasonError);
      await expect(OrganizationLifecycleService.archive(org.owner, { ...good, reason: "   " })).rejects.toBeInstanceOf(InvalidArchiveReasonError);
      expect((await nameOf(org.organizationId)).archivedAt).toBeNull();
      expect((await auditRows(org.organizationId)).some((a) => a.action === "organization.archived")).toBe(false);

      const archived = await OrganizationLifecycleService.archive(org.owner, { ...good, confirmName: `  ${name}  ` }); // surrounding space forgiven
      expect(archived.archivedAt).toBeInstanceOf(Date);
    });

    it("an ADMINISTRATOR cannot archive (OWNER only), whatever else they supply", async () => {
      const adminActor = await addTestMember(org.owner, "ADMINISTRATOR", "Adm");
      const name = (await nameOf(org.organizationId)).name;
      await expect(OrganizationLifecycleService.archive(adminActor, { confirmName: name, acknowledged: true, reason: "I want it gone" })).rejects.toBeInstanceOf(ArchiveNotPermittedError);
      for (const role of ["ACCOUNTANT", "BOOKKEEPER", "READ_ONLY", "EMPLOYEE"] as const) {
        await expect(OrganizationLifecycleService.archive(actorWithRole(org.owner, role), { confirmName: name, acknowledged: true, reason: "I want it gone" }), role).rejects.toBeInstanceOf(ArchiveNotPermittedError);
      }
      expect((await nameOf(org.organizationId)).archivedAt).toBeNull();
    });

    it("only a human can archive: an API key, AI agent or system actor holding the OWNER role is refused", async () => {
      const name = (await nameOf(org.organizationId)).name;
      for (const type of ["API", "AI", "SYSTEM"] as const) {
        await expect(OrganizationLifecycleService.archive({ ...org.owner, type }, { confirmName: name, acknowledged: true, reason: "automation says so" }), type).rejects.toThrow(/signed-in person/);
      }
      expect((await nameOf(org.organizationId)).archivedAt).toBeNull();
    });

    it("re-verifies the OWNER role in the database: an Actor object for a since-demoted owner cannot archive", async () => {
      const second = await addTestMember(org.owner, "OWNER", "Second");
      const members = await OrganizationService.listMembers(org.owner);
      await OrganizationService.updateMemberRole(org.owner, members.find((m) => m.userId === second.userId)!.membershipId, "READ_ONLY");
      await expect(archiveAsOwner(second)).rejects.toBeInstanceOf(ArchiveNotPermittedError); // `second` still CLAIMS OWNER
    });

    it("records who, when and why; touches no membership or seat; keeps the slug reserved; refuses a second archive", async () => {
      await addTestMember(org.owner, "BOOKKEEPER", "Seat Two");
      const membersBefore = await db.select().from(organizationMemberships).where(eq(organizationMemberships.organizationId, org.organizationId));
      const before = await nameOf(org.organizationId);

      const archived = await archiveAsOwner(org.owner, "Business closed at the end of the year");
      expect(archived).toMatchObject({ archivedByUserId: org.owner.userId, archiveReason: "Business closed at the end of the year" });
      expect(archived.seatLimit).toBe(before.seatLimit);
      expect(await db.select().from(organizationMemberships).where(eq(organizationMemberships.organizationId, org.organizationId))).toEqual(membersBefore);

      const audit = (await auditRows(org.organizationId)).filter((a) => a.action === "organization.archived");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorUserId: org.owner.userId, actorType: "HUMAN", entityId: org.organizationId });
      expect(audit[0]!.after).toMatchObject({ reason: "Business closed at the end of the year" });

      // The slug stays reserved while archived.
      await expect(OrganizationService.createWithOwner(org.owner.userId, { slug: before.slug, name: "Squatter" })).rejects.toBeInstanceOf(SlugTakenError);
      const created = await OrganizationService.createWithUniqueSlug(org.owner.userId, { name: before.name });
      expect(created.slug).not.toBe(before.slug);

      await expect(archiveAsOwner(org.owner)).rejects.toBeInstanceOf(OrganizationAlreadyArchivedError);
    });
  });

  describe("archiving and restoring as the platform admin", () => {
    it("needs a real reason (10+ characters) and a verified platform admin; ordinary users are refused", async () => {
      const ordinary = await createTestUser("Ordinary");
      await expect(PlatformAdminService.archiveOrganization(admin.id, org.organizationId, "too short")).rejects.toBeInstanceOf(InvalidArchiveReasonError);
      await expect(PlatformAdminService.archiveOrganization(admin.id, org.organizationId, "   ")).rejects.toBeInstanceOf(InvalidArchiveReasonError);
      await expect(PlatformAdminService.archiveOrganization(ordinary.id, org.organizationId, "a perfectly good reason")).rejects.toBeInstanceOf(PlatformAdminRequiredError);
      await expect(PlatformAdminService.restoreOrganization(ordinary.id, org.organizationId)).rejects.toBeInstanceOf(PlatformAdminRequiredError);
      expect((await nameOf(org.organizationId)).archivedAt).toBeNull();
      expect(await db.select().from(platformAdminAuditLogs)).toHaveLength(0);
    });

    it("archives and restores with BOTH audit trails (platform log + the organization's own), linked to each other", async () => {
      const archived = await PlatformAdminService.archiveOrganization(admin.id, org.organizationId, "Unpaid invoices, owner unreachable");
      expect(archived).toMatchObject({ archivedByUserId: admin.id, archiveReason: "Unpaid invoices, owner unreachable" });

      const platformRows = await db.select().from(platformAdminAuditLogs);
      expect(platformRows.map((r) => r.action)).toEqual(["organization.archived"]);
      expect(platformRows[0]).toMatchObject({ adminEmail: ADMIN_EMAIL, targetOrganization: org.organizationId });
      expect(platformRows[0]!.after).toMatchObject({ reason: "Unpaid invoices, owner unreachable" });

      const own = (await auditRows(org.organizationId)).find((a) => a.action === "organization.archived")!;
      expect(own).toMatchObject({ actorType: "SYSTEM", actorUserId: null });
      expect(own.metadata).toMatchObject({ platformAdmin: true, platformAuditId: platformRows[0]!.id });

      await expect(PlatformAdminService.archiveOrganization(admin.id, org.organizationId, "archive it twice please")).rejects.toBeInstanceOf(OrganizationAlreadyArchivedError);

      await PlatformAdminService.restoreOrganization(admin.id, org.organizationId);
      const restored = await nameOf(org.organizationId);
      expect([restored.archivedAt, restored.archivedByUserId, restored.archiveReason]).toEqual([null, null, null]);
      const platformAfter = await db.select().from(platformAdminAuditLogs);
      expect(platformAfter.map((r) => r.action).sort()).toEqual(["organization.archived", "organization.restored"]);
      const ownRestore = (await auditRows(org.organizationId)).find((a) => a.action === "organization.restored")!;
      expect(ownRestore.metadata).toMatchObject({ platformAdmin: true });
      await expect(PlatformAdminService.restoreOrganization(admin.id, org.organizationId)).rejects.toBeInstanceOf(OrganizationNotArchivedError);
    });

    it("shows archived status in the directory (filterable), the detail view, and the dashboard count", async () => {
      const other = await createTestOrg("stays-active");
      await PlatformAdminService.archiveOrganization(admin.id, org.organizationId, "Closed at the owner's request");

      const all = await DirectoryService.listOrganizations(admin.id, {});
      expect(all.total).toBe(2);
      expect(all.rows.find((r) => r.id === org.organizationId)).toMatchObject({ archiveReason: "Closed at the owner's request" });
      expect(all.rows.find((r) => r.id === org.organizationId)!.archivedAt).toBeInstanceOf(Date);
      expect(all.rows.find((r) => r.id === other.organizationId)!.archivedAt).toBeNull();
      expect((await DirectoryService.listOrganizations(admin.id, { status: "archived" })).rows.map((r) => r.id)).toEqual([org.organizationId]);
      expect((await DirectoryService.listOrganizations(admin.id, { status: "active" })).rows.map((r) => r.id)).toEqual([other.organizationId]);
      expect((await DirectoryService.getOrganization(admin.id, org.organizationId))!.archivedAt).toBeInstanceOf(Date);

      const metrics = await MetricsService.getPlatformMetrics(admin.id);
      expect(metrics.organizations).toEqual({ total: 2, archived: 1 });
    });

    it("a platform admin who is not a member still gets no access to the archived company's data (the boundary is unchanged)", async () => {
      await PlatformAdminService.archiveOrganization(admin.id, org.organizationId, "Closed at the owner's request");
      signInAs(admin.id);
      await expect(requireOrgAndActor(await slugOf(org.organizationId))).rejects.toBeInstanceOf(NotAMemberError);
    });
  });

  describe("while archived: the session choke point and server actions", () => {
    beforeEach(async () => {
      await archiveAsOwner(org.owner);
    });

    it("members get OrganizationArchivedError (with the digest the org error boundary renders); non-members get exactly what they always got", async () => {
      const slug = await slugOf(org.organizationId);
      signInAs(org.owner.userId);
      const error = await requireOrgAndActor(slug).then(() => null, (e: Error & { digest?: string }) => e);
      expect(error).toBeInstanceOf(OrganizationArchivedError);
      expect(error!.digest).toBe("ORGANIZATION_ARCHIVED");
      await expect(requireActor(org.organizationId)).rejects.toBeInstanceOf(OrganizationArchivedError);
      expect(await getActorForOrganization(org.organizationId)).toBeNull();

      const stranger = await createTestUser("Stranger");
      signInAs(stranger.id);
      await expect(requireOrgAndActor(slug)).rejects.toBeInstanceOf(NotAMemberError);
      await expect(requireActor(org.organizationId)).rejects.toBeInstanceOf(NotAMemberError);
      expect(await getActorForOrganization(org.organizationId)).toBeNull();
    });

    it("server actions refuse and change nothing (a customer is not created, a member is not invited)", async () => {
      const slug = await slugOf(org.organizationId);
      signInAs(org.owner.userId);
      const form = new FormData();
      form.set("name", "Sneaky Customer");
      form.set("email", "someone@example.test");
      form.set("role", "READ_ONLY");
      await expect(salesActions.createCustomerAction(slug, form)).rejects.toBeInstanceOf(OrganizationArchivedError);
      await expect(settingsActions.inviteMemberAction(slug, form)).rejects.toBeInstanceOf(OrganizationArchivedError);
      await expect(settingsActions.createInviteCodeAction(slug, { status: "idle" }, form)).rejects.toBeInstanceOf(OrganizationArchivedError);
      await expect(settingsActions.archiveCompanyAction(slug, new FormData())).rejects.toBeInstanceOf(OrganizationArchivedError);
      expect(await db.select().from(organizationMemberships).where(eq(organizationMemberships.organizationId, org.organizationId))).toHaveLength(1);
    });

    it("the [orgSlug] layout shows the archived page to members (restore button for OWNERs only), and 404s non-members; children are never rendered", async () => {
      const slug = await slugOf(org.organizationId);
      // (Membership is service-level data and is untouched by archive, so a member can be added to the archived company directly.)
      const accountant = await addTestMember(org.owner, "ACCOUNTANT", "Acct");

      signInAs(org.owner.userId);
      const ownerView = (await OrgLayout({ children: "SECRET CHILDREN", params: { orgSlug: slug } })) as { type: unknown; props: Record<string, unknown> };
      expect(ownerView.type).toBe(ArchivedCompanyNotice);
      expect(ownerView.props).toMatchObject({ canRestore: true, orgId: org.organizationId });
      expect(JSON.stringify(ownerView)).not.toContain("SECRET CHILDREN");

      signInAs(accountant.userId);
      const memberView = (await OrgLayout({ children: "SECRET CHILDREN", params: { orgSlug: slug } })) as { type: unknown; props: Record<string, unknown> };
      expect(memberView.type).toBe(ArchivedCompanyNotice);
      expect(memberView.props).toMatchObject({ canRestore: false, reason: null });

      const stranger = await createTestUser("Stranger");
      signInAs(stranger.id);
      await expect(OrgLayout({ children: null, params: { orgSlug: slug } })).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
    });

    it("the company chooser lists it under Archived (Restore for owners only), and never redirects into it or loops", async () => {
      const slug = await slugOf(org.organizationId);
      signInAs(org.owner.userId);
      // Their ONLY company is archived: the chooser renders (no redirect at all) and offers Restore.
      const page = textOf(await AppLandingPage({ searchParams: {} }));
      expect(page).toContain("Archived companies");
      expect(page).toContain((await nameOf(org.organizationId)).name);
      expect(page).toContain("Restore");
      expect(page).not.toMatch(new RegExp(`href=/${slug}( |$)`));

      // A person with one active and one archived company also lands on the chooser rather than being redirected away from it.
      const second = await OrganizationService.createWithUniqueSlug(org.owner.userId, { name: "Second Co" });
      const both = textOf(await AppLandingPage({ searchParams: {} }));
      expect(both).toContain("Archived companies");
      expect(both).toContain(`href=/${second.slug}`);

      // With nothing archived and exactly one company, the old single-membership redirect still applies.
      const lone = await createTestUser("Lone");
      signInAs(lone.id);
      const loneOrg = await OrganizationService.createWithOwner(lone.id, { slug: "lone-co", name: "Lone Co" });
      expect(await redirectTarget(AppLandingPage({ searchParams: {} }))).toBe(`/${loneOrg.slug}`);
    });

    it("a non-owner member sees the archived company in the chooser without a Restore button", async () => {
      const accountant = await addTestMember(org.owner, "ACCOUNTANT", "Acct2");
      signInAs(accountant.userId);
      const page = textOf(await AppLandingPage({ searchParams: {} }));
      expect(page).toContain("Archived companies");
      expect(page).toContain("Ask an owner to restore it");
      expect(page).not.toContain(`value=${org.organizationId}`);
    });

    it("the switcher list (listMembershipsForUser) excludes it, while the chooser's own list still includes it", async () => {
      expect(await OrganizationService.listMembershipsForUser(org.owner.userId)).toEqual([]);
      const all = await OrganizationService.listAllMembershipsForUser(org.owner.userId);
      expect(all).toHaveLength(1);
      expect(all[0]!.organization.archivedAt).toBeInstanceOf(Date);
      expect(await OrganizationService.getMembership(org.owner.userId, org.organizationId)).toBeNull();
    });
  });

  describe("restoring from the company chooser", () => {
    it("an OWNER restores their archived company (audited); an ADMINISTRATOR, a former member and a stranger cannot", async () => {
      const adminMember = await addTestMember(org.owner, "ADMINISTRATOR", "Adm");
      const former = await addTestMember(org.owner, "OWNER", "Former");
      const members = await OrganizationService.listMembers(org.owner);
      await OrganizationService.removeMember(org.owner, members.find((m) => m.userId === former.userId)!.membershipId);
      await archiveAsOwner(org.owner);
      const stranger = await createTestUser("Stranger");

      for (const userId of [adminMember.userId, former.userId, stranger.id]) {
        await expect(OrganizationLifecycleService.restore(userId, org.organizationId), userId).rejects.toBeInstanceOf(ArchiveNotPermittedError);
      }
      expect((await nameOf(org.organizationId)).archivedAt).toBeInstanceOf(Date);

      const restored = await OrganizationLifecycleService.restore(org.owner.userId, org.organizationId);
      expect(restored.archivedAt).toBeNull();
      const restoredAudit = (await auditRows(org.organizationId)).find((a) => a.action === "organization.restored")!;
      expect(restoredAudit).toMatchObject({ actorUserId: org.owner.userId, actorType: "HUMAN" });
      await expect(OrganizationLifecycleService.restore(org.owner.userId, org.organizationId)).rejects.toBeInstanceOf(OrganizationNotArchivedError);
    });

    it("the Restore button's server action works end to end and lands back in the company", async () => {
      await archiveAsOwner(org.owner);
      signInAs(org.owner.userId);
      const form = new FormData();
      form.set("organizationId", org.organizationId);
      expect(await redirectTarget(restoreCompanyAction(form))).toBe(`/${await slugOf(org.organizationId)}`);
      expect((await nameOf(org.organizationId)).archivedAt).toBeNull();
      // And a forged id for somebody else's company does nothing.
      const other = await createTestOrg("not-mine");
      await archiveAsOwner(other.owner);
      const forged = new FormData();
      forged.set("organizationId", other.organizationId);
      expect(await redirectTarget(restoreCompanyAction(forged))).toMatch(/^\/app\?error=/);
      expect((await nameOf(other.organizationId)).archivedAt).toBeInstanceOf(Date);
    });
  });

  describe("while archived: API keys", () => {
    it("a valid key gets a clear 403 problem (no extra query - the flag rides in the existing lookup), and works again after a restore", async () => {
      const key = await makeKey(org.owner, ["contacts:read"], { rateLimitPerMinute: 600 });
      const statements: string[] = [];
      const original = pg.Client.prototype.query;
      const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        const first = args[0] as string | { text?: string };
        statements.push(typeof first === "string" ? first : (first?.text ?? ""));
        return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
      } as never);
      try {
        statements.length = 0;
        expect((await call("GET", "/me", { key: key.secret })).status).toBe(200);
        expect(statements).toHaveLength(2); // exactly the budget from before the archive feature: key lookup + rate-limit upsert

        await archiveAsOwner(org.owner);
        statements.length = 0;
        const res = await call("GET", "/me", { key: key.secret });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ status: 403, code: "organization_archived" });
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        expect(statements).toHaveLength(1); // the single lookup; the request never gets as far as the rate-limit statement or a tenant transaction
        expect(JSON.stringify(res.body)).not.toContain(org.organizationId);

        // Every endpoint family is behind the same authentication.
        expect((await call("GET", "/customers", { key: key.secret })).status).toBe(403);
        expect((await call("GET", "/reports/trial-balance", { key: key.secret })).status).toBe(403);
      } finally {
        spy.mockRestore();
      }

      await OrganizationLifecycleService.restore(org.owner.userId, org.organizationId);
      resetApiThrottle();
      expect((await call("GET", "/me", { key: key.secret })).status).toBe(200);
    });

    it("a wrong secret for the archived company's key prefix learns nothing about the archive", async () => {
      const key = await makeKey(org.owner, ["contacts:read"]);
      await archiveAsOwner(org.owner);
      const tampered = key.secret.slice(0, -3) + (key.secret.endsWith("AAA") ? "BBB" : "AAA");
      const res = await call("GET", "/me", { key: tampered });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("invalid_api_key");
    });
  });

  describe("while archived: webhooks", () => {
    it("dispatch (manual and post-response) sends nothing and fans nothing out; events stay in the outbox and flow after a restore", async () => {
      enableWebhookEncryption();
      configurePostResponseDispatch(null);
      const sales = await createSalesFixtures(org.owner, "AUD");
      const sub = await makeSubscription(org.owner, { eventTypes: ["invoice.created"] });
      expect(sub.subscription.id).toBeTruthy();
      await InvoiceService.create(org.owner, {
        customerContactId: sales.customerContactId,
        issueDate: new Date("2026-01-01"),
        dueDate: new Date("2026-01-31"),
        currency: "AUD",
        arAccountId: sales.arAccountId,
        lines: [{ description: "Consulting", quantity: "1", unitPrice: "100.00", accountId: sales.revenueAccountId }],
      });
      const undispatched = async () =>
        (await withTenant(org.organizationId, (tx) => tx.select().from(domainEvents).where(eq(domainEvents.organizationId, org.organizationId)))).filter((e) => e.dispatchedAt === null && e.type === "invoice.created");
      expect(await undispatched()).toHaveLength(1);

      await archiveAsOwner(org.owner);
      const transport = fakeTransport();
      const deps = { resolver: fakeResolver(), transport, now: () => new Date("2026-06-01T10:00:00Z"), random: () => 0.5 };
      const result = await WebhookDispatchService.dispatch(org.organizationId, { limit: 10 }, deps);
      expect(result).toMatchObject({ skipped: null, eventsFannedOut: 0, deliveriesCreated: 0, claimed: 0, delivered: 0, failed: 0 });
      expect(transport.calls).toHaveLength(0);
      expect(await undispatched()).toHaveLength(1); // still pending, untouched

      configurePostResponseDispatch({ enabled: true, deps });
      await scheduleDispatchAfterResponse(org.organizationId);
      expect(transport.calls).toHaveLength(0);
      expect(await undispatched()).toHaveLength(1);
      expect((await pendingSummary(org.owner)).undispatchedEvents).toBeGreaterThanOrEqual(1);

      await OrganizationLifecycleService.restore(org.owner.userId, org.organizationId);
      const after = await WebhookDispatchService.dispatch(org.organizationId, { limit: 10 }, deps);
      expect(after).toMatchObject({ eventsFannedOut: 2, deliveriesCreated: 1, delivered: 1 }); // the customer event from the fixture fans out too, but only the subscribed invoice event creates a delivery
      expect(transport.calls).toHaveLength(1);
      expect(await undispatched()).toHaveLength(0);
    });

    it("an archived company's dispatch statement count equals an idle active one (no extra query)", async () => {
      enableWebhookEncryption();
      const statements: string[] = [];
      const original = pg.Client.prototype.query;
      const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        const first = args[0] as string | { text?: string };
        statements.push(typeof first === "string" ? first : (first?.text ?? ""));
        return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
      } as never);
      try {
        const deps = { resolver: fakeResolver(), transport: fakeTransport(), now: () => new Date("2026-06-01T10:00:00Z"), random: () => 0.5 };
        statements.length = 0;
        await WebhookDispatchService.dispatch(org.organizationId, { limit: 10 }, deps);
        const idleActive = statements.length;
        await archiveAsOwner(org.owner);
        statements.length = 0;
        await WebhookDispatchService.dispatch(org.organizationId, { limit: 10 }, deps);
        expect(statements.length).toBeLessThanOrEqual(idleActive);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("while archived: AI auto-execution and recurring runners", () => {
    it("auto-execution skips with an explicit reason and generates nothing; recurring 'generate due' returns nothing; a restore resumes the same configuration", async () => {
      const sales = await createSalesFixtures(org.owner, "AUD");
      const purchases = await createPurchasesFixtures(org.owner, "AUD");
      await AutonomySettingsService.setLevel(org.owner, 4);
      await AutoApprovedActionsService.setEnabled(org.owner, "RECURRING_INVOICE_AUTO_GENERATE", true);
      await AutoApprovedActionsService.setEnabled(org.owner, "RECURRING_BILL_AUTO_GENERATE", true);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await RecurringInvoiceService.create(org.owner, {
        customerContactId: sales.customerContactId,
        name: "Retainer",
        currency: "AUD",
        arAccountId: sales.arAccountId,
        frequency: "MONTHLY",
        startDate: yesterday,
        lines: [{ description: "Retainer", quantity: "1", unitPrice: "500.00", accountId: sales.revenueAccountId }],
      });
      await RecurringBillService.create(org.owner, {
        supplierContactId: purchases.supplierContactId,
        name: "Rent",
        currency: "AUD",
        apAccountId: purchases.apAccountId,
        frequency: "MONTHLY",
        startDate: yesterday,
        lines: [{ description: "Rent", quantity: "1", unitPrice: "900.00", accountId: purchases.expenseAccountId }],
      });

      await archiveAsOwner(org.owner);
      const results = await AutoExecutionService.runPendingAutoExecutions(org.owner);
      expect(results.every((r) => r.executed === 0)).toBe(true);
      expect(results.find((r) => r.actionType === "RECURRING_INVOICE_AUTO_GENERATE")?.skippedReason).toBe("organization is archived");
      expect(results.find((r) => r.actionType === "BANK_RECONCILIATION_AUTO_MATCH")?.skippedReason).toBe("organization is archived");
      expect(await RecurringInvoiceService.generateDue(org.owner)).toEqual([]);
      expect(await RecurringBillService.generateDue(org.owner)).toEqual([]);
      expect(await InvoiceService.list(org.owner, {})).toHaveLength(0);

      // Level and whitelist were left untouched, so the restore resumes exactly as configured.
      await OrganizationLifecycleService.restore(org.owner.userId, org.organizationId);
      expect(await AutonomySettingsService.getLevel(org.organizationId)).toBe(4);
      const resumed = await AutoExecutionService.runPendingAutoExecutions(org.owner);
      expect(resumed.find((r) => r.actionType === "RECURRING_INVOICE_AUTO_GENERATE")?.executed).toBe(1);
      expect(resumed.find((r) => r.actionType === "RECURRING_BILL_AUTO_GENERATE")?.executed).toBe(1);
    });
  });

  describe("restoring returns exactly the prior state", () => {
    it("ledger, trial balance, audit ids, memberships, API keys and webhook subscriptions are byte-identical after archive -> restore (plus the two lifecycle audit rows)", async () => {
      enableWebhookEncryption();
      const accounts = await createSampleAccounts(org.owner, "AUD");
      await PostingService.postJournal(org.owner, {
        postingDate: new Date("2026-02-01"),
        memo: "Sale",
        lines: [
          { accountId: accounts[0]!, debit: "1100.00", currency: "AUD" },
          { accountId: accounts[4]!, credit: "1100.00", currency: "AUD" },
        ],
      });
      await PostingService.postJournal(org.owner, {
        postingDate: new Date("2026-02-10"),
        memo: "Expense",
        lines: [
          { accountId: accounts[5]!, debit: "250.50", currency: "AUD" },
          { accountId: accounts[0]!, credit: "250.50", currency: "AUD" },
        ],
      });
      await addTestMember(org.owner, "READ_ONLY", "Viewer");
      const key = await makeKey(org.owner, ["contacts:read"], { rateLimitPerMinute: 600 });
      await makeSubscription(org.owner, { eventTypes: ["invoice.created"] });

      const snapshot = async () => {
        const asOf = new Date("2026-12-31");
        const [orgRow] = await db.select().from(organizations).where(eq(organizations.id, org.organizationId));
        return {
          trialBalance: JSON.stringify(await LedgerService.getTrialBalance(org.owner, asOf)),
          entries: JSON.stringify(await withTenant(org.organizationId, (tx) => tx.select().from(journalEntries).where(eq(journalEntries.organizationId, org.organizationId)).orderBy(journalEntries.entryNumber))),
          lines: JSON.stringify(await withTenant(org.organizationId, (tx) => tx.select().from(journalLines).where(eq(journalLines.organizationId, org.organizationId)).orderBy(journalLines.id))),
          memberships: JSON.stringify(await db.select().from(organizationMemberships).where(eq(organizationMemberships.organizationId, org.organizationId)).orderBy(organizationMemberships.id)),
          apiKeys: JSON.stringify(await withTenant(org.organizationId, (tx) => tx.select().from(apiKeys).where(eq(apiKeys.organizationId, org.organizationId)))),
          subs: JSON.stringify(await withTenant(org.organizationId, (tx) => tx.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.organizationId, org.organizationId)))),
          // The organization row itself, minus the archive columns and the touched timestamp.
          org: JSON.stringify({ ...orgRow!, archivedAt: null, archivedByUserId: null, archiveReason: null, updatedAt: null }),
          auditIds: (await auditRows(org.organizationId)).map((a) => a.id).sort(),
        };
      };

      const before = await snapshot();
      expect(JSON.parse(before.trialBalance).length).toBeGreaterThan(0);

      await archiveAsOwner(org.owner);
      await OrganizationLifecycleService.restore(org.owner.userId, org.organizationId);
      const after = await snapshot();

      expect(after.trialBalance).toBe(before.trialBalance);
      expect(after.entries).toBe(before.entries);
      expect(after.lines).toBe(before.lines);
      expect(after.memberships).toBe(before.memberships);
      expect(after.apiKeys).toBe(before.apiKeys);
      expect(after.subs).toBe(before.subs);
      expect(after.org).toBe(before.org);
      // Every pre-existing audit row is still there with the same id; exactly two were added (archived, restored).
      expect(after.auditIds.filter((id) => before.auditIds.includes(id))).toEqual(before.auditIds);
      const added = (await auditRows(org.organizationId)).filter((a) => !before.auditIds.includes(a.id)).map((a) => a.action).sort();
      expect(added).toEqual(["organization.archived", "organization.restored"]);

      // The previously-issued API key works again, untouched.
      resetApiThrottle();
      expect((await call("GET", "/me", { key: key.secret })).status).toBe(200);
    });
  });

  describe("while archived: practice and consolidation", () => {
    it("a practice's link to an archived client is unavailable: out of the dashboard, no refresh, no details, no new proposal - and back after a restore", async () => {
      const w = await createPracticeWorld();
      const NOW = new Date("2026-10-05T10:00:00Z");
      const A = w.clients.A;

      const before = await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW, verifyLinks: false });
      expect(before.rows.map((r) => r.clientOrganizationId)).toContain(A.organizationId);

      await archiveAsOwner(A.owner);

      const dashboard = await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW, verifyLinks: false });
      expect(dashboard.rows.map((r) => r.clientOrganizationId)).not.toContain(A.organizationId);
      expect(dashboard.notAccessibleCount).toBe(before.notAccessibleCount + 1);
      expect(JSON.stringify(dashboard)).not.toContain(A.name);

      const refreshed = await HealthService.refreshClient(w.s1Actor, w.practiceId, A.organizationId, NOW);
      expect(refreshed.state).toBe("NO_ACCESS");
      expect(refreshed.message).toBe(`${A.name} is currently unavailable, so its books cannot be read.`);
      expect(refreshed.message).not.toMatch(/seat|member|owner|administrator|archiv/i);

      const gate = await requireClientActor(w.s1.id, w.practiceId, { organizationId: A.organizationId, name: A.name }).then(() => null, (e: unknown) => e);
      expect(gate).toBeInstanceOf(NotAClientMemberError);
      expect((gate as NotAClientMemberError).unavailable).toBe(true);

      // A fresh proposal to the archived company's slug is the same generic failure as an unknown slug.
      await expect(ClientLinkService.propose(w.partnerActor, w.practiceId, A.slug)).rejects.toBeInstanceOf(ProposalNotPossibleError);
      await expect(ClientLinkService.propose(w.partnerActor, w.practiceId, "no-such-company-anywhere")).rejects.toBeInstanceOf(ProposalNotPossibleError);

      await OrganizationLifecycleService.restore(A.owner.userId, A.organizationId);
      const restored = await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW, verifyLinks: false });
      expect(restored.rows.map((r) => r.clientOrganizationId)).toContain(A.organizationId);
      expect((await HealthService.refreshClient(w.s1Actor, w.practiceId, A.organizationId, NOW)).state).toBe("OK");
    });

    it("a consolidation group excludes an archived entity with the usual notice - no name, id, slug or figures - and includes it again after a restore", async () => {
      const world = await createConsolidationWorld();
      const group = await createFullGroup(world);
      const TO = new Date("2026-03-31");
      const C = world.entities.C;

      const full = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO);
      expect(full.entities.map((e) => e.name)).toContain(C.name);

      await archiveAsOwner(C.ownerActor);
      const bs = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO);
      expect(bs.entities.map((e) => e.name)).not.toContain(C.name);
      expect(bs.exclusions.count).toBe(1);
      expect(bs.exclusions.notice).toBe("1 entity excluded — no access");
      const json = JSON.stringify(bs);
      expect(json).not.toContain(C.name);
      expect(json).not.toContain(C.slug);
      expect(json).not.toContain(C.organizationId);
      // The group's own configuration still lists it without leaking whose books it is.
      const detail = await GroupService.get(world.groupActor, group.id);
      expect(JSON.stringify(detail)).not.toContain("7000.00");

      await OrganizationLifecycleService.restore(C.ownerActor.userId, C.organizationId);
      const back = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO);
      expect(back.entities.map((e) => e.name)).toContain(C.name);
      expect(back.exclusions.count).toBe(0);
    });
  });

  describe("permission model is unchanged", () => {
    it("archiving adds no permission: the PermissionDeniedError behaviour of ordinary actions is untouched", async () => {
      await expect(OrganizationService.addMemberByEmail(actorWithRole(org.owner, "READ_ONLY"), "x@example.test", "READ_ONLY")).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });
});
