/**
 * Instrumentation for the "database connection discipline" tests (docs/security.md
 * section 13). Wraps `withTenant` and `withUserScope` so a test can prove:
 *  - SEQUENTIAL access: at most ONE scoped transaction is ever open at a time (`maxActive` is 1:
 *    no Promise.all fan-out, and none nested inside another);
 *  - WHICH organizations were opened, in what order (`tenantCalls`) — so a test can show that a
 *    pending, revoked or non-member client was never opened at all.
 * Use with `vi.mock("@/db/tenant", ...)` / `vi.mock("@/db/user-scope", ...)` at the top of a test file.
 */
export const tracker = {
  tenantCalls: [] as string[],
  userScopeCalls: [] as string[],
  active: 0,
  maxActive: 0,
  reset() {
    this.tenantCalls = [];
    this.userScopeCalls = [];
    this.active = 0;
    this.maxActive = 0;
  },
};

async function tracked<T>(fn: () => Promise<T>): Promise<T> {
  tracker.active += 1;
  tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
  try {
    return await fn();
  } finally {
    tracker.active -= 1;
  }
}

export function instrumentTenant<M extends { withTenant: (id: string, cb: never) => Promise<unknown> }>(mod: M): M {
  const original = mod.withTenant;
  return {
    ...mod,
    withTenant: (id: string, cb: never) => {
      tracker.tenantCalls.push(id);
      return tracked(() => original(id, cb));
    },
  };
}

export function instrumentUserScope<M extends { withUserScope: (id: string, cb: never) => Promise<unknown> }>(mod: M): M {
  const original = mod.withUserScope;
  return {
    ...mod,
    withUserScope: (id: string, cb: never) => {
      tracker.userScopeCalls.push(id);
      return tracked(() => original(id, cb));
    },
  };
}
