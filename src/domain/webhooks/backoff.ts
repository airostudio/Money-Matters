/**
 * Retry policy (docs/api.md "Retries"). Pure, so it is unit-tested without a clock or a database.
 *
 * After a failed AUTOMATIC attempt number n (1-based), the next attempt is due after RETRY_DELAYS_SECONDS[n-1] seconds,
 * spread by +/-20% jitter so a burst of failures does not retry in lockstep. After MAX_ATTEMPTS automatic attempts the
 * delivery is dead-lettered (FAILED; still replayable by a person). Retries are on demand - there is no scheduler - so
 * "due" means "eligible the next time dispatch runs".
 */
export const RETRY_DELAYS_SECONDS: readonly number[] = [60, 300, 1800, 7200, 21600, 43200, 86400];
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
export const JITTER_RATIO = 0.2;

/** Consecutive failed automatic attempts (across deliveries) that trip the circuit breaker. */
export const CIRCUIT_BREAKER_THRESHOLD = 20;

/** Delay in seconds before the next attempt, or null when the automatic attempts are exhausted. `random` is injectable (0..1). */
export function nextDelaySeconds(autoAttemptsSoFar: number, random: () => number = Math.random): number | null {
  if (!Number.isInteger(autoAttemptsSoFar) || autoAttemptsSoFar < 1) throw new Error("autoAttemptsSoFar must be a positive integer.");
  if (autoAttemptsSoFar >= MAX_ATTEMPTS) return null;
  const base = RETRY_DELAYS_SECONDS[autoAttemptsSoFar - 1] as number;
  const jitter = 1 - JITTER_RATIO + random() * 2 * JITTER_RATIO;
  return Math.round(base * jitter);
}

export function nextAttemptAt(now: Date, autoAttemptsSoFar: number, random: () => number = Math.random): Date | null {
  const delay = nextDelaySeconds(autoAttemptsSoFar, random);
  return delay === null ? null : new Date(now.getTime() + delay * 1000);
}

export interface BreakerDecision {
  consecutiveFailures: number;
  /** True exactly when this failure crosses the threshold: the subscription must be disabled. */
  trip: boolean;
}

/** Success resets the counter; each failure increments it; the threshold-th consecutive failure trips the breaker. */
export function nextBreakerState(consecutiveFailures: number, success: boolean, threshold: number = CIRCUIT_BREAKER_THRESHOLD): BreakerDecision {
  if (success) return { consecutiveFailures: 0, trip: false };
  const next = consecutiveFailures + 1;
  return { consecutiveFailures: next, trip: next >= threshold };
}
