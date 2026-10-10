import { describe, expect, it } from "vitest";
import {
  CIRCUIT_BREAKER_THRESHOLD,
  JITTER_RATIO,
  MAX_ATTEMPTS,
  RETRY_DELAYS_SECONDS,
  nextAttemptAt,
  nextBreakerState,
  nextDelaySeconds,
} from "@/domain/webhooks/backoff";
import { MAX_ERROR_CHARS, MAX_EXCERPT_CHARS, sanitiseError, sanitiseExcerpt } from "@/domain/webhooks/sanitize";

describe("retry schedule", () => {
  it("is 1m, 5m, 30m, 2h, 6h, 12h, 24h with at most 8 automatic attempts", () => {
    expect(RETRY_DELAYS_SECONDS).toEqual([60, 300, 1800, 7200, 21600, 43200, 86400]);
    expect(MAX_ATTEMPTS).toBe(8);
  });

  it("with no jitter (random = 0.5) returns exactly the schedule, then null when exhausted", () => {
    const mid = () => 0.5;
    RETRY_DELAYS_SECONDS.forEach((base, i) => expect(nextDelaySeconds(i + 1, mid)).toBe(base));
    expect(nextDelaySeconds(8, mid)).toBeNull();
    expect(nextDelaySeconds(9, mid)).toBeNull();
  });

  it("jitter stays within +/-20% of each base delay at both extremes", () => {
    expect(JITTER_RATIO).toBe(0.2);
    RETRY_DELAYS_SECONDS.forEach((base, i) => {
      expect(nextDelaySeconds(i + 1, () => 0)).toBe(Math.round(base * 0.8));
      expect(nextDelaySeconds(i + 1, () => 0.999999)).toBe(Math.round(base * 1.2));
      for (let n = 0; n < 50; n += 1) {
        const d = nextDelaySeconds(i + 1)!;
        expect(d).toBeGreaterThanOrEqual(Math.round(base * 0.8));
        expect(d).toBeLessThanOrEqual(Math.round(base * 1.2));
      }
    });
  });

  it("every delay's MINIMUM exceeds the previous delay's minimum", () => {
    const mins = RETRY_DELAYS_SECONDS.map((_, i) => nextDelaySeconds(i + 1, () => 0)!);
    for (let i = 1; i < mins.length; i += 1) expect(mins[i]).toBeGreaterThan(mins[i - 1] as number);
  });

  it("nextAttemptAt adds the delay to now and is null once exhausted; bad input throws", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(nextAttemptAt(now, 1, () => 0.5)).toEqual(new Date("2026-01-01T00:01:00.000Z"));
    expect(nextAttemptAt(now, 7, () => 0.5)).toEqual(new Date("2026-01-02T00:00:00.000Z"));
    expect(nextAttemptAt(now, 8)).toBeNull();
    expect(() => nextDelaySeconds(0)).toThrow();
    expect(() => nextDelaySeconds(1.5)).toThrow();
  });
});

describe("circuit breaker counter", () => {
  it("increments on failure, resets on success, and trips exactly at the threshold", () => {
    expect(CIRCUIT_BREAKER_THRESHOLD).toBe(20);
    expect(nextBreakerState(0, false)).toEqual({ consecutiveFailures: 1, trip: false });
    expect(nextBreakerState(18, false)).toEqual({ consecutiveFailures: 19, trip: false });
    expect(nextBreakerState(19, false)).toEqual({ consecutiveFailures: 20, trip: true });
    expect(nextBreakerState(25, false).trip).toBe(true);
    expect(nextBreakerState(19, true)).toEqual({ consecutiveFailures: 0, trip: false });
    expect(nextBreakerState(2, false, 3)).toEqual({ consecutiveFailures: 3, trip: true });
  });
});

const chr = (...codes: number[]) => String.fromCharCode(...codes);

describe("response excerpt sanitiser", () => {
  it("strips control characters, ANSI escapes, NUL and bidi overrides, and collapses whitespace", () => {
    const hostile = ["line1\r\nline2", chr(0), chr(27), "[31mred", chr(27), "[0m", chr(0x202e), "gnp.exe", chr(0x2028), "para", chr(7), "bell\t\ttab"].join("");
    const out = sanitiseExcerpt(hostile)!;
    for (const ch of out) {
      const cp = ch.codePointAt(0) as number;
      expect(cp > 0x1f && (cp < 0x7f || cp > 0x9f) && cp !== 0x202e && cp !== 0x2028, `U+${cp.toString(16)}`).toBe(true);
    }
    expect(out).toBe("line1 line2 [31mred [0m gnp.exe para bell tab");
    expect(out.includes("\n")).toBe(false);
  });

  it("caps the length and marks truncation", () => {
    const out = sanitiseExcerpt("a".repeat(5000))!;
    expect(out.length).toBe(MAX_EXCERPT_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(sanitiseExcerpt("short")).toBe("short");
    expect(sanitiseError("e".repeat(1000)).length).toBe(MAX_ERROR_CHARS);
  });

  it("returns null for empty / whitespace-only / null input and tolerates invalid UTF-8", () => {
    expect(sanitiseExcerpt("")).toBeNull();
    expect(sanitiseExcerpt("   \n\t ")).toBeNull();
    expect(sanitiseExcerpt(null)).toBeNull();
    expect(sanitiseExcerpt(undefined)).toBeNull();
    expect(sanitiseExcerpt(Buffer.from([0xff, 0xfe, 0x41, 0x42]))).toBe("AB");
  });

  it("leaves HTML intact as text (rendering escapes it) but never an unbounded or control-laden string", () => {
    expect(sanitiseExcerpt("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });
});
