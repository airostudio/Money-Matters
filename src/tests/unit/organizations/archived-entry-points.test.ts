import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildControllerTools } from "@/domain/ai-controller/controller-tools";
import { buildWriteTools } from "@/domain/ai-controller/write-tools";
import { API_SCOPES } from "@/domain/api/scopes";

/**
 * THE enumeration test for "an archived company is closed through EVERY path" (docs/security.md section 17).
 *
 * The archive check is deliberately NOT a per-request extra query in `withTenant` (the hot path). It lives at the few
 * places where a person, key or process is turned into an Actor for an organization. This test reads the source and
 * fails when a NEW such place appears - or an existing one changes shape - until its author has added it to the table
 * below and said how it refuses an archived organization. A future entry point cannot silently skip the check.
 */
const SRC = path.resolve(__dirname, "../../..");

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "tests" ? [] : filesIn(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
const FILES = filesIn(SRC);
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const read = (f: string) => readFileSync(f, "utf8");
/** Source with comments removed, so prose describing a call is not mistaken for making it. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const byRel = new Map(FILES.map((f) => [rel(f), f]));

function filesMatching(re: RegExp, within: (r: string) => boolean = () => true): string[] {
  return FILES.filter((f) => within(rel(f)) && re.test(code(f))).map(rel).sort();
}

function callsIn(file: string): string[] {
  const c = code(byRel.get(file)!);
  return [...new Set([...c.matchAll(/OrganizationService\.(getMembershipWithState|getMembership|listAllMembershipsForUser|listMembershipsForUser|getBySlug)\(/g)].map((m) => m[1]!))].sort();
}

/** Every module that resolves "this person, in this organization" or "which organizations", and how each handles ARCHIVED. */
const MEMBERSHIP_RESOLUTION_TABLE: Record<string, { calls: string[]; archived: string }> = {
  "lib/session.ts": {
    calls: ["getBySlug", "getMembership", "getMembershipWithState"],
    archived:
      "requireOrgAndActor / requireActor throw OrganizationArchivedError for a member and NotAMemberError otherwise; getActorForOrganization uses getMembership, which returns null for an archived organization",
  },
  "app/[orgSlug]/layout.tsx": {
    calls: ["getBySlug", "getMembershipWithState", "listMembershipsForUser"],
    archived: "renders the archived page for members and never renders children; 404 for non-members; the switcher list excludes archived",
  },
  "app/[orgSlug]/requests/[requestId]/attachment/[messageId]/route.ts": {
    calls: ["getBySlug"],
    archived: "then getActorForOrganization (null for archived -> 404)",
  },
  "app/app/page.tsx": {
    calls: ["listAllMembershipsForUser"],
    archived: "splits active from archived; archived never participates in the single-membership redirect; Restore only for OWNER",
  },
  "app/app/groups/[groupId]/page.tsx": { calls: ["listMembershipsForUser"], archived: "excludes archived (the consolidation entity picker)" },
  "domain/consolidation/entity-access.ts": {
    calls: ["listMembershipsForUser"],
    archived: "archived entities are absent from the access map -> excluded with the usual 'excluded - no access' notice",
  },
  "domain/practice/client-access.ts": {
    calls: ["getMembership", "listMembershipsForUser"],
    archived: "archived clients are absent from the access map / have no membership; explainNotAMember answers a neutral 'unavailable'",
  },
  "domain/practice/health-service.ts": { calls: ["getMembership"], archived: "getMembership is null for archived -> NO_ACCESS with the neutral 'unavailable' message" },
  "domain/practice/client-link-service.ts": { calls: ["getBySlug"], archived: "an archived organization cannot be proposed a link (same generic error as unknown)" },
  "domain/organizations/organization-service.ts": {
    calls: ["getMembershipWithState"],
    archived: "getMembership wraps it and returns null for an archived organization unless a caller opts in with includeArchived",
  },
  "domain/organizations/lifecycle-service.ts": { calls: ["getMembershipWithState"], archived: "restore: the only path that must see an archived organization, and it demands an active OWNER" },
};

describe("archived organizations: every membership-resolution entry point is accounted for", () => {
  it("the set of modules that resolve a membership / organization is exactly the audited table", () => {
    const found = filesMatching(/OrganizationService\.(getMembershipWithState|getMembership|listAllMembershipsForUser|listMembershipsForUser|getBySlug)\(/);
    expect(found).toEqual(Object.keys(MEMBERSHIP_RESOLUTION_TABLE).sort());
  });

  it("each audited module makes exactly the calls the table says (a new call must be reviewed and added)", () => {
    for (const [file, entry] of Object.entries(MEMBERSHIP_RESOLUTION_TABLE)) {
      expect(callsIn(file), file).toEqual([...entry.calls].sort());
      expect(entry.archived.length, file).toBeGreaterThan(10);
    }
  });

  it("getMembership and listMembershipsForUser exclude archived organizations by default", () => {
    const svc = code(byRel.get("domain/organizations/organization-service.ts")!);
    const getMembership = svc.slice(svc.indexOf("async getMembership("), svc.indexOf("async getMembershipWithState("));
    expect(getMembership).toMatch(/found\.archivedAt && !options\.includeArchived\) return null/);
    const list = svc.slice(svc.indexOf("async listMembershipsForUser("), svc.indexOf("async listAllMembershipsForUser("));
    expect(list).toMatch(/isNull\(organizations\.archivedAt\)/);
  });

  it("nothing outside the lifecycle code opts back in with includeArchived", () => {
    expect(filesMatching(/includeArchived\s*:\s*true/)).toEqual([]);
  });

  it("the session helpers refuse an archived organization for members (requireOrgAndActor, requireActor)", () => {
    const session = code(byRel.get("lib/session.ts")!);
    expect(session.match(/throw new OrganizationArchivedError\(/g)?.length).toBe(2);
    expect(session).toMatch(/getActorForOrganization[\s\S]*getMembership\(user\.id, organizationId\)/);
  });
});

describe("archived organizations: where an Actor is built", () => {
  it("only the audited modules construct an Actor object literal (userId + organizationId + role)", () => {
    const re = /\{\s*userId\s*(?::[^{}]*)?,\s*organizationId[^{}]*role\s*[:,]/;
    const found = filesMatching(re);
    expect(found).toEqual([
      "domain/api/api-auth.ts",
      // Phase 10 Slice 3. `identity.ts` builds the AUTOMATION actor from a rule's authoriser, and `run-recording.ts` the SYSTEM actor
      // for audit rows about a rule switching itself off. Both are reachable ONLY from the evaluation pass, whose first
      // statement reads the archived flag and returns before any rule is even loaded (see the automation test below).
      "domain/automation/identity.ts",
      "domain/automation/run-recording.ts",
      "domain/consolidation/entity-access.ts",
      "domain/organizations/invite-service.ts",
      "domain/organizations/lifecycle-service.ts",
      "domain/organizations/organization-service.ts",
      "domain/practice/client-access.ts",
      "domain/practice/health-service.ts",
      "domain/webhooks/dispatch-service.ts",
      "lib/session.ts",
    ]);
  });

  it("the request layer (pages, layouts, actions, route handlers, lib) never opens a database transaction itself", () => {
    for (const f of FILES.filter((x) => /^(app|lib|components)\//.test(rel(x)))) {
      expect(code(f), rel(f)).not.toMatch(/from ["']@\/db\/(tenant|user-scope|client)["']/);
    }
  });

  it("every organization server action / route handler resolves its Actor through the session helpers", () => {
    const orgActions = FILES.filter((f) => /^app\/\[orgSlug\]\/.*(actions\.ts|route\.ts)$/.test(rel(f)));
    expect(orgActions.length).toBeGreaterThan(10);
    for (const f of orgActions) {
      expect(code(f), rel(f)).toMatch(/requireOrgAndActor|requireActor|getActorForOrganization/);
    }
  });
});

describe("archived organizations: the non-session paths", () => {
  it("API key authentication reads the archived flag in the SAME lookup join (no extra query)", () => {
    const auth = code(byRel.get("domain/api/api-auth.ts")!);
    expect(auth).toMatch(/innerJoin\(organizations, eq\(organizations\.id, apiKeyIndex\.organizationId\)\)/);
    expect(auth).toMatch(/organizationArchivedAt: organizations\.archivedAt/);
    expect(auth).toMatch(/if \(row\.organizationArchivedAt\) throw apiErrors\.organizationArchived\(\)/);
    // And every v1 route goes through the one handler that authenticates.
    const handler = code(byRel.get("domain/api/handler.ts")!);
    expect(handler).toMatch(/authenticateApiKey\(/);
    for (const f of FILES.filter((x) => /^app\/api\/v1\/.*route\.ts$/.test(rel(x)) && !rel(x).endsWith("openapi.json/route.ts"))) {
      expect(code(f), rel(f)).toMatch(/route\(|methodNotAllowed\(|notFoundHandler/);
    }
  });

  it("webhook dispatch reads the archived flag in the same statement as its try-lock and sends nothing for an archived organization", () => {
    const dispatch = code(byRel.get("domain/webhooks/dispatch-service.ts")!);
    expect(dispatch).toMatch(/pg_try_advisory_xact_lock[\s\S]*archived_at IS NOT NULL FROM organizations/);
    expect(dispatch).toMatch(/if \(archived\) return \[\] as Claim\[\]/);
  });

  it("automation evaluation reads the archived flag in the same statement as its try-lock and returns before loading a single rule", () => {
    const engine = code(byRel.get("domain/automation/engine.ts")!);
    expect(engine).toMatch(/pg_try_advisory_xact_lock[\s\S]*archived_at IS NOT NULL FROM organizations/);
    expect(engine).toMatch(/if \(h\.archived\) return \{ result: \{ \.\.\.result, skipped: "archived" \}, info: null, jobs: \[\] \}/);
    // The early returns come BEFORE the rules are read and before any event is touched, so an archived company's events stay pending.
    expect(engine.indexOf('skipped: "archived"')).toBeLessThan(engine.indexOf(".from(automationRules)"));
    expect(engine.indexOf('skipped: "archived"')).toBeLessThan(engine.indexOf(".from(domainEvents)"));
    // Every way in goes through runPass: the on-demand button, the post-response task, and the outbox "Send now" action.
    expect(code(byRel.get("domain/webhooks/post-response.ts")!)).toMatch(/AutomationEngine\.runPass\(/);
    expect(code(byRel.get("app/[orgSlug]/settings/webhooks/actions.ts")!)).toMatch(/AutomationEngine\.runPass\(/);
    expect(code(byRel.get("app/[orgSlug]/settings/automation/actions.ts")!)).toMatch(/AutomationEngine\.runNow\(/);
    const callers = FILES.filter((f) => /AutomationEngine\.(runPass|runNow)\(/.test(code(f))).map(rel).sort();
    expect(callers).toEqual(["app/[orgSlug]/settings/automation/actions.ts", "app/[orgSlug]/settings/webhooks/actions.ts", "domain/webhooks/post-response.ts"]);
  });

  it("management of automations, integrations and notifications resolves its Actor through the session helpers (archived -> refused)", () => {
    for (const f of ["app/[orgSlug]/settings/automation/actions.ts", "app/[orgSlug]/settings/integrations/actions.ts", "app/[orgSlug]/notifications/actions.ts"]) {
      expect(code(byRel.get(f)!), f).toMatch(/requireOrgAndActor/);
    }
  });

  it("AI auto-execution and the recurring 'generate due' runners skip an archived organization", () => {
    expect(code(byRel.get("domain/ai-controller/auto-execution-policy.ts")!)).toMatch(/getLevelAndArchived[\s\S]*if \(archived\) return \{ approved: false/);
    expect(code(byRel.get("domain/sales/recurring-invoice-service.ts")!)).toMatch(/archived_at IS NOT NULL/);
    expect(code(byRel.get("domain/purchases/recurring-bill-service.ts")!)).toMatch(/archived_at IS NOT NULL/);
  });
});

describe("management of archive / invites is human-only and not reachable by AI or the API", () => {
  it("no AI controller tool mentions archive, restore, invite, or membership management", () => {
    const tools = [...buildControllerTools([]), ...buildWriteTools("question", "model")];
    expect(tools.length).toBeGreaterThan(5);
    for (const tool of tools) {
      expect(tool.name, tool.name).not.toMatch(/archiv|restor|invit|join|member|seat/i);
      const haystack = `${tool.description} ${JSON.stringify(tool.inputSchema)}`;
      expect(haystack, tool.name).not.toMatch(/invite code|join code|archive (the|this|a|an|your) (company|organi[sz]ation)|restore (the|this|a|an|your) (company|organi[sz]ation)|(add|remove|invite|manage) (a |the )?(member|team)|seat limit/i);
    }
  });

  it("no AI controller module imports the organization lifecycle or invite services", () => {
    for (const f of FILES.filter((x) => rel(x).startsWith("domain/ai-controller/"))) {
      expect(code(f), rel(f)).not.toMatch(/lifecycle-service|invite-service|archive-rules/);
    }
  });

  it("no public API scope, endpoint or module touches archive or invites", () => {
    for (const scope of API_SCOPES as readonly string[]) expect(scope).not.toMatch(/archiv|invite|member|organi[sz]ation/i);
    for (const f of FILES.filter((x) => rel(x).startsWith("domain/api/") || rel(x).startsWith("app/api/"))) {
      expect(code(f), rel(f)).not.toMatch(/lifecycle-service|invite-service|OrganizationLifecycleService|InviteService/);
    }
  });
});

describe("new modules: connection discipline", () => {
  const NEW_MODULES = [
    "domain/organizations/archive-rules.ts",
    "domain/organizations/lifecycle-service.ts",
    "domain/organizations/invite-service.ts",
    "domain/organizations/invite-code.ts",
    "domain/organizations/limits.ts",
    "app/app/actions.ts",
    "domain/automation/engine.ts",
    "domain/automation/executors.ts",
    "domain/automation/rule-service.ts",
    "domain/automation/scans.ts",
    "domain/integrations/connection-service.ts",
    "domain/notifications/notification-service.ts",
    "components/shell/create-invite-form.tsx",
    "components/shell/archive-company-form.tsx",
  ];

  it("no Promise.all / allSettled / race / any, and no private database connection", () => {
    for (const file of NEW_MODULES) {
      const c = code(byRel.get(file)!);
      expect(c, file).not.toMatch(/Promise\.(all|allSettled|race|any)\b/);
      expect(c, file).not.toMatch(/from ["']pg["']/);
      expect(c, file).not.toMatch(/new (Pool|Client)\(/);
      expect(c, file).not.toMatch(/DIRECT_DATABASE_URL|connectionString/);
    }
  });

  it("the invite and lifecycle services never log (the code must not reach any log line)", () => {
    for (const file of ["domain/organizations/invite-service.ts", "domain/organizations/invite-code.ts", "domain/organizations/lifecycle-service.ts", "app/app/actions.ts"]) {
      expect(code(byRel.get(file)!), file).not.toMatch(/console\./);
    }
  });
});
