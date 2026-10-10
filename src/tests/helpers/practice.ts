import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { organizations } from "@/db/schema";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { PracticeConsentService } from "@/domain/practice/consent-service";
import { PracticeService } from "@/domain/practice/practice-service";
import type { PracticeActor } from "@/domain/practice/types";
import { OrganizationService } from "@/domain/organizations/organization-service";
import type { Actor } from "@/domain/permissions/permission-service";
import type { MembershipRole } from "@/domain/permissions/roles";
import { createTestOrg, createTestUser } from "./db";

export type ClientKey = "A" | "B" | "C" | "D";

export interface ClientWorld {
  key: ClientKey;
  organizationId: string;
  name: string;
  slug: string;
  /** The client organization's own OWNER. */
  owner: Actor;
}

export interface PracticeWorld {
  practiceId: string;
  partner: { id: string; email: string };
  s1: { id: string; email: string };
  s2: { id: string; email: string };
  outsider: { id: string; email: string };
  partnerActor: PracticeActor;
  s1Actor: PracticeActor;
  s2Actor: PracticeActor;
  outsiderActor: PracticeActor;
  clients: Record<ClientKey, ClientWorld>;
  /** S1's real Actor in client A (ACCOUNTANT unless changed). */
  s1In(key: ClientKey, role?: MembershipRole): Actor;
}

/** Adds `userId` to a client organization with `role`, done by that organization's own owner. */
export async function joinClient(client: ClientWorld, user: { id: string; email: string }, role: MembershipRole) {
  await OrganizationService.addMemberByEmail(client.owner, user.email, role);
}

/** The client's OWNER accepts the pending proposal from the practice. */
export async function acceptProposal(client: ClientWorld, practiceId: string) {
  const consents = await PracticeConsentService.list(client.owner);
  const consent = consents.find((c) => c.practiceId === practiceId);
  if (!consent) throw new Error("no consent to accept");
  return PracticeConsentService.accept(client.owner, consent.id);
}

export async function revokeConsent(client: ClientWorld, practiceId: string) {
  const consents = await PracticeConsentService.list(client.owner);
  const consent = consents.find((c) => c.practiceId === practiceId && c.status === "ACTIVE");
  if (!consent) throw new Error("no active consent to revoke");
  return PracticeConsentService.revoke(client.owner, consent.id);
}

/**
 * The acceptance-test world: a practice with a partner P and staff S1, S2 (S2 is also staff),
 * an unrelated outsider, and four client organizations:
 *
 *   A  link ACTIVE   S1 is an ACCOUNTANT member
 *   B  link PENDING  (proposed, not yet accepted)  — S1 is a member
 *   C  link REVOKED  (accepted, then revoked by the client)  — S1 is a member
 *   D  link ACTIVE   but S1 is NOT a member
 *
 * `options.links: false` skips the handshake so a test can run it itself.
 */
export async function createPracticeWorld(options: { links?: boolean } = {}): Promise<PracticeWorld> {
  const withLinks = options.links ?? true;
  const partner = await createTestUser("Partner");
  const s1 = await createTestUser("StaffOne");
  const s2 = await createTestUser("StaffTwo");
  const outsider = await createTestUser("Outsider");
  const partnerActor: PracticeActor = { userId: partner.id };

  const practice = await PracticeService.create(partnerActor, { name: "Smith & Co Accountants" });
  await PracticeService.addStaffByEmail(partnerActor, practice.id, s1.email, "STAFF");
  await PracticeService.addStaffByEmail(partnerActor, practice.id, s2.email, "STAFF");

  const clients = {} as Record<ClientKey, ClientWorld>;
  for (const key of ["A", "B", "C", "D"] as const) {
    const created = await createTestOrg(`client-${key.toLowerCase()}`, { seatLimit: 50 });
    const org = (await db.select().from(organizations).where(eq(organizations.id, created.organizationId)))[0]!;
    clients[key] = { key, organizationId: org.id, name: org.name, slug: org.slug, owner: created.owner };
  }

  await joinClient(clients.A, s1, "ACCOUNTANT");
  await joinClient(clients.B, s1, "ACCOUNTANT");
  await joinClient(clients.C, s1, "ACCOUNTANT");

  if (withLinks) {
    for (const key of ["A", "B", "C", "D"] as const) {
      await ClientLinkService.propose(partnerActor, practice.id, clients[key].slug);
    }
    await acceptProposal(clients.A, practice.id);
    await acceptProposal(clients.C, practice.id);
    await revokeConsent(clients.C, practice.id);
    await acceptProposal(clients.D, practice.id);
    // B stays PENDING. The practice learns the observed statuses when it verifies.
    await ClientLinkService.verify(partnerActor, practice.id, [clients.A.organizationId, clients.C.organizationId, clients.D.organizationId]);
  }

  return {
    practiceId: practice.id,
    partner,
    s1,
    s2,
    outsider,
    partnerActor,
    s1Actor: { userId: s1.id },
    s2Actor: { userId: s2.id },
    outsiderActor: { userId: outsider.id },
    clients,
    s1In: (key, role = "ACCOUNTANT") => ({ userId: s1.id, organizationId: clients[key].organizationId, role }),
  };
}

/**
 * Creates one more client organization with the full handshake done (proposed by the partner,
 * accepted by its owner, observed by the practice) and S1 a member with `s1Role` (pass null for
 * "S1 is not a member"). Returns the client's world entry.
 */
export async function addLinkedClient(
  w: PracticeWorld,
  namePrefix: string,
  opts: { s1Role?: MembershipRole | null; accept?: boolean } = {},
): Promise<ClientWorld> {
  const created = await createTestOrg(namePrefix, { seatLimit: 50 });
  const org = (await db.select().from(organizations).where(eq(organizations.id, created.organizationId)))[0]!;
  const client: ClientWorld = { key: "A", organizationId: org.id, name: org.name, slug: org.slug, owner: created.owner };
  if (opts.s1Role !== null) await joinClient(client, w.s1, opts.s1Role ?? "ACCOUNTANT");
  await ClientLinkService.propose(w.partnerActor, w.practiceId, client.slug);
  if (opts.accept !== false) {
    await acceptProposal(client, w.practiceId);
    await ClientLinkService.verify(w.partnerActor, w.practiceId, [client.organizationId]);
  }
  return client;
}
