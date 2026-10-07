/**
 * Build-time validation of the environment the *running application* needs.
 *
 * A green build proves almost nothing about runtime configuration: Next.js
 * compiles fine with no database and no auth secret, then returns 500 on
 * every request. Each variable missing here produces a different, confusing
 * symptom — a missing NEXTAUTH_SECRET surfaces only as
 * "[next-auth] CLIENT_FETCH_ERROR ... problem with the server configuration"
 * in the browser console, with nothing in the build log at all.
 *
 * Checked during `npm run db:migrate` (which the build runs first), so the
 * build log names the missing variable while there is still a log to read.
 *
 * Pure and dependency-free so it is unit-testable and safe to import from
 * scripts.
 */
import type { EnvLike } from "@/db/connection";
import { diagnoseConnectionString } from "@/db/connection";

export interface EnvProblem {
  variable: string;
  problem: string;
  /** What breaks at runtime if this is left unset — the symptom to match against. */
  symptom: string;
  fix: string;
}

/** Minimum entropy for a secret we would accept in production. */
const MIN_SECRET_LENGTH = 32;

const DB_VARS = ["DATABASE_URL", "POSTGRES_URL", "SUPABASE_DB_URL", "POSTGRES_PRISMA_URL"];

export function checkRuntimeEnv(env: EnvLike): EnvProblem[] {
  const problems: EnvProblem[] = [];

  const dbVar = DB_VARS.find((name) => (env[name] ?? "").trim() !== "");
  if (!dbVar) {
    problems.push({
      variable: "DATABASE_URL",
      problem: "not set",
      symptom: "every page that reads data returns 500",
      fix:
        "Set it to the mm_app role's connection string — NOT the admin connection used " +
        "for migrations, which is exempt from row-level security.",
    });
  } else {
    const invalid = diagnoseConnectionString(env[dbVar]!);
    if (invalid) {
      problems.push({
        variable: dbVar,
        problem: invalid,
        symptom: "every page that reads data returns 500",
        fix: "Correct the connection string; run `npm run db:doctor` to check it.",
      });
    }
  }

  const secret = (env.NEXTAUTH_SECRET ?? "").trim();
  if (secret === "") {
    problems.push({
      variable: "NEXTAUTH_SECRET",
      problem: "not set",
      symptom:
        "/api/auth/* returns 500 and the browser console shows " +
        "'[next-auth][error][CLIENT_FETCH_ERROR] ... problem with the server configuration'",
      fix: "Generate one with `openssl rand -base64 32` and set it. Keep it stable — changing it invalidates every existing session.",
    });
  } else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push({
      variable: "NEXTAUTH_SECRET",
      problem: `only ${secret.length} characters long`,
      symptom: "sessions are signed with a weak key",
      fix: `Use at least ${MIN_SECRET_LENGTH} characters: \`openssl rand -base64 32\`.`,
    });
  }

  // NEXTAUTH_URL is optional on Vercel (NextAuth infers it from VERCEL_URL),
  // but required anywhere else or OAuth callbacks and redirects break.
  const onVercel = (env.VERCEL ?? "") !== "";
  if (!onVercel && (env.NEXTAUTH_URL ?? "").trim() === "") {
    problems.push({
      variable: "NEXTAUTH_URL",
      problem: "not set (and not running on Vercel, which would infer it)",
      symptom: "sign-in redirects go to the wrong origin",
      fix: "Set it to the application's public origin, e.g. https://app.example.com",
    });
  }

  return problems;
}

export interface OptionalFeatureNote {
  feature: string;
  variable: string;
  note: string;
}

/**
 * Optional features whose configuration is absent or invalid. These are NOT runtime failures: the application builds and
 * runs normally and the feature is simply switched off (fail closed), so they are reported separately from
 * `checkRuntimeEnv` and phrased as notes, never as warnings that the deployed app will break.
 */
export function checkOptionalFeatures(env: EnvLike): OptionalFeatureNote[] {
  const notes: OptionalFeatureNote[] = [];
  const raw = (env.WEBHOOK_SECRET_ENCRYPTION_KEY ?? "").trim();
  if (raw === "") {
    notes.push({
      feature: "Webhooks",
      variable: "WEBHOOK_SECRET_ENCRYPTION_KEY",
      note: "not set - webhooks are disabled (no subscription can be created and nothing is delivered; the rest of the app is unaffected). To enable them set it to 32 random bytes, base64: `openssl rand -base64 32`.",
    });
  } else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || Buffer.from(raw, "base64").length !== 32) {
    notes.push({
      feature: "Webhooks",
      variable: "WEBHOOK_SECRET_ENCRYPTION_KEY",
      note: "is not 32 random bytes, base64-encoded - webhooks stay disabled until it is fixed (`openssl rand -base64 32`).",
    });
  }
  return notes;
}

/** Formats optional-feature notes for a build log. Never prints any variable's value. */
export function formatOptionalFeatureNotes(notes: OptionalFeatureNote[]): string {
  return ["", ...notes.map((n) => `[env] NOTE (optional feature): ${n.feature} - ${n.variable} ${n.note}`), ""].join("\n");
}

/** Formats problems for a build log. Never prints any variable's value. */
export function formatEnvProblems(problems: EnvProblem[]): string {
  const lines = [
    "",
    "[env] WARNING: the application's runtime configuration is incomplete.",
    "[env] The build will still succeed, but the deployed app will fail as described below.",
    "",
  ];
  for (const p of problems) {
    lines.push(`  ${p.variable} — ${p.problem}`);
    lines.push(`    symptom: ${p.symptom}`);
    lines.push(`    fix:     ${p.fix}`);
    lines.push("");
  }
  return lines.join("\n");
}
