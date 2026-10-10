import type { ActorType } from "@/domain/permissions/permission-service";

/**
 * Limits that keep a practice inside the database connection budget
 * (docs/security.md section 13, src/db/client.ts: the Supabase session pooler
 * caps the whole project at roughly 15 clients, and every withTenant /
 * withUserScope checks one out). Everything below is a documented cap, not a
 * tuning knob.
 */
/** Most client links (any non-terminal status) one practice may hold. */
export const MAX_CLIENTS_PER_PRACTICE = 100;
/** Clients shown — and therefore at most verified or refreshed — per dashboard page. */
export const DASHBOARD_PAGE_SIZE = 10;
/** Most clients any bulk action (assign, apply group, create task, refresh) may touch at once: one page. */
export const MAX_BULK_SELECTION = DASHBOARD_PAGE_SIZE;
/** Most active staff a practice may have. */
export const MAX_PRACTICE_STAFF = 25;
/** Most practices one user may found (limits proposal spam). */
export const MAX_PRACTICES_PER_USER = 3;
/** Most PENDING proposals a single client organization will hold at once (limits proposal spam). */
export const MAX_PENDING_PROPOSALS_PER_ORG = 5;

export type PracticeRole = "PARTNER" | "MANAGER" | "STAFF";

export const PRACTICE_ROLE_RANK: Record<PracticeRole, number> = { STAFF: 1, MANAGER: 2, PARTNER: 3 };

export const PRACTICE_ROLE_LABELS: Record<PracticeRole, string> = {
  PARTNER: "Partner",
  MANAGER: "Manager",
  STAFF: "Staff",
};

export type LinkStatus = "PENDING" | "ACTIVE" | "DECLINED" | "REVOKED" | "WITHDRAWN";

/** The acting user at PRACTICE level (a practice belongs to no organization, so there is no org here). */
export interface PracticeActor {
  userId: string;
  type?: ActorType;
}

/** A snapshot older than this is shown as stale. */
export const SNAPSHOT_STALE_AFTER_HOURS = 24;
