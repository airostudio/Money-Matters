import { describe, expect, it } from "vitest";
import { checkRuntimeEnv, formatEnvProblems } from "@/lib/runtime-env";

const VALID_DB = "postgresql://mm_app:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres";
const VALID_SECRET = "a".repeat(32);
const COMPLETE = { DATABASE_URL: VALID_DB, NEXTAUTH_SECRET: VALID_SECRET, VERCEL: "1" };

describe("checkRuntimeEnv", () => {
  it("passes a complete environment", () => {
    expect(checkRuntimeEnv(COMPLETE)).toEqual([]);
  });

  it("catches a missing DATABASE_URL — the green-build/500-at-runtime case", () => {
    const problems = checkRuntimeEnv({ ...COMPLETE, DATABASE_URL: undefined });
    expect(problems.map((p) => p.variable)).toContain("DATABASE_URL");
  });

  it("catches an invalid DATABASE_URL and says what is wrong with it", () => {
    const problems = checkRuntimeEnv({
      ...COMPLETE,
      DATABASE_URL: "postgresql://postgres:[YOUR-PASSWORD]@db.abc.supabase.co:5432/postgres",
    });
    expect(problems[0]?.problem).toContain("[YOUR-PASSWORD]");
  });

  it("accepts Vercel's own Postgres integration variable in place of DATABASE_URL", () => {
    const problems = checkRuntimeEnv({
      NEXTAUTH_SECRET: VALID_SECRET,
      VERCEL: "1",
      POSTGRES_URL: VALID_DB,
    });
    expect(problems).toEqual([]);
  });

  it("catches a missing NEXTAUTH_SECRET and names the exact browser symptom", () => {
    const problems = checkRuntimeEnv({ ...COMPLETE, NEXTAUTH_SECRET: undefined });
    const secret = problems.find((p) => p.variable === "NEXTAUTH_SECRET");
    expect(secret).toBeDefined();
    // The console error a developer would actually be looking at.
    expect(secret?.symptom).toContain("CLIENT_FETCH_ERROR");
  });

  it("catches a too-short NEXTAUTH_SECRET", () => {
    const problems = checkRuntimeEnv({ ...COMPLETE, NEXTAUTH_SECRET: "short" });
    expect(problems.find((p) => p.variable === "NEXTAUTH_SECRET")?.problem).toContain("5 characters");
  });

  it("requires NEXTAUTH_URL off Vercel, but not on it", () => {
    expect(
      checkRuntimeEnv({ DATABASE_URL: VALID_DB, NEXTAUTH_SECRET: VALID_SECRET }).map(
        (p) => p.variable,
      ),
    ).toContain("NEXTAUTH_URL");

    // On Vercel it is inferred from VERCEL_URL, so demanding it would be noise.
    expect(checkRuntimeEnv(COMPLETE)).toEqual([]);
  });

  it("reports every problem at once rather than one per deploy cycle", () => {
    const problems = checkRuntimeEnv({});
    expect(problems.map((p) => p.variable).sort()).toEqual([
      "DATABASE_URL",
      "NEXTAUTH_SECRET",
      "NEXTAUTH_URL",
    ]);
  });
});

describe("formatEnvProblems", () => {
  it("names each variable, its symptom and its fix, without printing any value", () => {
    const output = formatEnvProblems(
      checkRuntimeEnv({ DATABASE_URL: VALID_DB, NEXTAUTH_SECRET: "supersecretvalue" }),
    );
    expect(output).toContain("NEXTAUTH_SECRET");
    expect(output).toContain("symptom:");
    expect(output).toContain("fix:");
    expect(output).not.toContain("supersecretvalue");
    expect(output).not.toContain("pw@");
  });
});
