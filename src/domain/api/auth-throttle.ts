/**
 * Best-effort, PER-INSTANCE throttle on repeated authentication FAILURES from one client address, so a flood of
 * invalid keys cannot be turned into a flood of database lookups.
 *
 * Honest limits (docs/security.md section 15): the counters live in this process's memory. On a serverless
 * deployment every instance has its own, a cold start resets them, and the address comes from a proxy header a
 * client can influence unless the platform overwrites it. It is therefore NOT a security boundary against a
 * determined attacker - the boundary is the key's 256-bit secret. What it buys is cheap: the common cases (a
 * misconfigured integration retrying a bad key in a tight loop, a naive scanner) are cut off BEFORE any query, on
 * the instance that is receiving them, which is exactly where the database cost would otherwise land. Malformed
 * keys never reach the database at all (parseApiKey), and a correct key's rate limit is in the database.
 *
 * Only FAILURES count, and a success clears the address, so a legitimate integration is never throttled by it.
 */
export const THROTTLE_MAX_FAILURES = 20;
export const THROTTLE_WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 5_000;

interface Entry {
  failures: number;
  windowStart: number;
}

export class AuthThrottle {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxFailures = THROTTLE_MAX_FAILURES,
    private readonly windowMs = THROTTLE_WINDOW_MS,
    private readonly maxClients = MAX_TRACKED_CLIENTS,
  ) {}

  /** Seconds the client must wait, or 0 when it may proceed. */
  retryAfterSeconds(client: string, now: number = Date.now()): number {
    const entry = this.entries.get(client);
    if (!entry) return 0;
    if (now - entry.windowStart >= this.windowMs) {
      this.entries.delete(client);
      return 0;
    }
    if (entry.failures < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((entry.windowStart + this.windowMs - now) / 1000));
  }

  recordFailure(client: string, now: number = Date.now()): void {
    const entry = this.entries.get(client);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      if (!entry && this.entries.size >= this.maxClients) this.evictOldest();
      this.entries.set(client, { failures: 1, windowStart: now });
      return;
    }
    entry.failures += 1;
  }

  recordSuccess(client: string): void {
    this.entries.delete(client);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private evictOldest(): void {
    // Map iteration order is insertion order: the first key is the oldest tracked client. Bounded memory.
    const oldest = this.entries.keys().next();
    if (!oldest.done) this.entries.delete(oldest.value);
  }
}

export const authThrottle = new AuthThrottle();

/** The client address for throttling: first hop of X-Forwarded-For (what a platform proxy appends), else X-Real-IP, else a shared bucket. */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return (first || headers.get("x-real-ip")?.trim() || "unknown").slice(0, 64);
}
