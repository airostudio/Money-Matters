import type { automationRules } from "@/db/schema";
import type { Actor } from "@/domain/permissions/permission-service";
import type { OutboundDeps } from "@/domain/webhooks/outbound";
import type { JobContext } from "./context";
import type { RuleSpec } from "./vocabulary";

export type RuleRow = typeof automationRules.$inferSelect;

/** Where an evaluation pass was started from (recorded on every run). */
export type PassSource = "MANUAL" | "POST_RESPONSE" | "OUTBOX_DISPATCH";

export interface PassDeps extends OutboundDeps {
  now?: () => Date;
  /** Encryption environment for channel sends (tests). */
  env?: Record<string, string | undefined>;
  /** Origin used to build links inside channel messages (tests). Defaults to NEXTAUTH_URL. */
  baseUrl?: string | null;
  /** Called with the number of open tenant transactions at the instant a channel send's HTTP client runs (tests). */
  onSend?: () => void;
}

/** A rule that has been re-validated and given its execution identity for THIS pass. */
export interface ParsedRule {
  row: RuleRow;
  spec: RuleSpec;
  actor: Actor;
}

export interface OrgInfo {
  slug: string;
  baseCurrency: string;
}

export interface PlannedJob {
  jobId: string;
  rule: ParsedRule;
  jobKey: string;
  context: JobContext;
  /** Attempts already made before this one (0 for a new job). */
  attemptsMade: number;
}

export type Outcome =
  | { outcome: "SUCCESS"; created?: { type: string; id: string }; note?: string }
  | { outcome: "SKIPPED"; reason: string }
  | { outcome: "FAILED"; reason: string; retryAt?: Date };

export interface PassResult {
  skipped: "archived" | "paused" | "busy" | null;
  eventsExamined: number;
  claimed: number;
  succeeded: number;
  failed: number;
  skippedRuns: number;
  rulesDisabled: number;
  rearmed: number;
  /** True when a per-pass or daily cap held some work back for a later pass. */
  capped: boolean;
}

export const emptyPassResult = (skipped: PassResult["skipped"] = null): PassResult => ({
  skipped,
  eventsExamined: 0,
  claimed: 0,
  succeeded: 0,
  failed: 0,
  skippedRuns: 0,
  rulesDisabled: 0,
  rearmed: 0,
  capped: false,
});
