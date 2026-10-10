import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getServerSession } from "next-auth";
import { db } from "@/db/client";
import { organizations, platformAdminAuditLogs } from "@/db/schema";
import { UserService } from "@/domain/auth/user-service";
import * as archiveActions from "@/app/admin/organizations/[orgId]/actions";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";

const ADMIN_EMAIL = "typhoon.tall69@gmail.com";
const originalEnv = process.env.PLATFORM_ADMIN_EMAILS;
const mockedSession = vi.mocked(getServerSession);
const signInAs = (userId: string | null) => mockedSession.mockResolvedValue(userId ? ({ user: { id: userId } } as never) : null);

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  const error = (await promise.then(
    () => null,
    (e: { digest?: string }) => e,
  )) as { digest?: string } | null;
  const digest = error?.digest ?? "";
  expect(digest.startsWith("NEXT_REDIRECT"), digest).toBe(true);
  return decodeURIComponent(digest.split(";")[2] ?? "");
}

describe("Platform admin archive / restore actions", () => {
  let admin: { id: string };
  let ordinary: { id: string };
  let org: Awaited<ReturnType<typeof createTestOrg>>;

  afterAll(closeTestPools);

  beforeEach(async () => {
    await resetDatabase();
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    admin = await UserService.register({ email: ADMIN_EMAIL, name: "Admin", password: "password123" });
    ordinary = await UserService.register({ email: "someone@example.test", name: "Someone", password: "password123" });
    org = await createTestOrg("admin-archive");
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = originalEnv;
    mockedSession.mockReset();
  });

  const form = (reason = "Owner asked us to close it") => {
    const f = new FormData();
    f.set("organizationId", org.organizationId);
    f.set("reason", reason);
    return f;
  };
  const archivedAt = async () => (await db.select().from(organizations).where(eq(organizations.id, org.organizationId)))[0]!.archivedAt;

  it("exports exactly the two actions, and each 404s for an ordinary user and a signed-out visitor, changing nothing", async () => {
    expect(Object.keys(archiveActions).sort()).toEqual(["archiveOrganizationAction", "restoreOrganizationAction"]);
    for (const session of [ordinary.id, null]) {
      signInAs(session);
      for (const [name, action] of Object.entries(archiveActions)) {
        await expect(action(form()), name).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
      }
    }
    expect(await archivedAt()).toBeNull();
    expect(await db.select().from(platformAdminAuditLogs)).toHaveLength(0);
  });

  it("as the admin: a missing reason redirects back with the reason; a good one archives, then restore reverses it, both audited", async () => {
    signInAs(admin.id);
    expect(await redirectOf(archiveActions.archiveOrganizationAction(form("short")))).toMatch(/^\/admin\/organizations\/[0-9a-f-]+\?error=Give a reason of at least 10 characters/);
    expect(await archivedAt()).toBeNull();

    expect(await redirectOf(archiveActions.archiveOrganizationAction(form()))).toMatch(/\?ok=Organization archived/);
    expect(await archivedAt()).toBeInstanceOf(Date);
    expect(await redirectOf(archiveActions.archiveOrganizationAction(form()))).toMatch(/\?error=This company is already archived/);

    expect(await redirectOf(archiveActions.restoreOrganizationAction(form()))).toMatch(/\?ok=Organization restored/);
    expect(await archivedAt()).toBeNull();
    expect((await db.select().from(platformAdminAuditLogs)).map((r) => r.action).sort()).toEqual(["organization.archived", "organization.restored"]);
  });
});
