import { waitUntil } from "@vercel/functions";
import { webhookEncryptionStatus } from "./secret-crypto";
import { MAX_BATCH_LIMIT, WebhookDispatchService, type DispatchDeps } from "./dispatch-service";

/**
 * Best-effort immediate dispatch AFTER the request that caused events has been answered (docs/architecture.md section 11).
 *
 * The mechanism is `waitUntil` from `@vercel/functions` - the one supported way to keep a serverless invocation alive
 * for work that continues after the response (an un-awaited promise is simply frozen when the function returns). Off
 * Vercel (local `next dev` / `next start`, tests) `waitUntil` is a no-op and the promise just runs on the live process, so
 * there is ONE mechanism and no environment sniffing. (Next 14.2 has no `after()`; it arrived in Next 15.)
 *
 * Safety properties, each tested:
 *  - it can NEVER throw into the request: every path is wrapped, and the dispatch itself never rejects;
 *  - it starts only after the caller's transaction has COMMITTED (callers invoke it after the service call returned), and
 *    yields one macrotask first, so the request's own connection is never held while it runs - it cannot deadlock the pool;
 *  - it skips when this instance is already dispatching for the organization (no stampede from a burst of requests);
 *    across instances, deliveries are protected by SKIP LOCKED + leases, so a duplicate dispatch only finds nothing to do;
 *  - it does nothing at all without the encryption key, and nothing in the test environment unless a test enables it.
 *
 * It is best effort by design: if the platform kills the invocation, events stay in the outbox and are sent by the next
 * dispatch (the "Send now" action, or the next best-effort run). That is why the settings page shows a pending banner.
 */
let enabledOverride: boolean | undefined;
let depsOverride: DispatchDeps | undefined;
const inFlight = new Set<string>();

export function configurePostResponseDispatch(options: { enabled?: boolean; deps?: DispatchDeps } | null): void {
  enabledOverride = options?.enabled;
  depsOverride = options?.deps;
}

function isEnabled(): boolean {
  if (enabledOverride !== undefined) return enabledOverride;
  // Existing integration tests count every tenant transaction; a background dispatch would perturb them. Tests opt in.
  return !(process.env.VITEST || process.env.NODE_ENV === "test");
}

/** Resolves when the (possibly absent) background dispatch for `organizationId` has finished - used by tests only. */
export function scheduleDispatchAfterResponse(organizationId: string): Promise<void> {
  try {
    if (!isEnabled() || inFlight.has(organizationId) || !webhookEncryptionStatus(depsOverride?.env ?? process.env).configured) {
      return Promise.resolve();
    }
    inFlight.add(organizationId);
    const task = (async () => {
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await WebhookDispatchService.dispatch(organizationId, { limit: MAX_BATCH_LIMIT }, depsOverride ?? {});
      } catch {
        // Best effort: the events remain in the outbox for the next dispatch.
      } finally {
        inFlight.delete(organizationId);
      }
    })();
    try {
      waitUntil(task);
    } catch {
      // No request context to attach to: the promise simply keeps running on this process.
    }
    return task;
  } catch {
    return Promise.resolve();
  }
}
