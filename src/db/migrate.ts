import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  DatabaseConfigurationError,
  explainConnectionError,
  poolerAwareRoleName,
  resolveConnection,
  type ResolvedConnection,
} from "./connection";
import { checkRuntimeEnv, formatEnvProblems } from "@/lib/runtime-env";

const SAFE_PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateSafePassword(length = 32): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += SAFE_PASSWORD_ALPHABET[bytes[i]! % SAFE_PASSWORD_ALPHABET.length];
  }
  return out;
}

function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Fails fast with a diagnosed error instead of letting the first migration
 * query surface a bare driver TypeError/errno with no context.
 */
async function preflight(pool: Pool, connection: ResolvedConnection): Promise<void> {
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    throw new DatabaseConfigurationError(explainConnectionError(error, connection));
  }
}

/**
 * drizzle/0001_row_level_security.sql creates `mm_app` with NOLOGIN and no
 * password — a fixed password committed to source control is a real
 * vulnerability the moment it runs against an internet-reachable database
 * (mm_app can set app.current_org_id to anything, so a leaked password is a
 * cross-tenant read of everything). This is the one place a real credential
 * gets attached to the role, and it never touches git:
 *
 * - MM_APP_DB_PASSWORD if provided, applied on every run. Local dev pins this
 *   so .env's connection strings stay valid across re-migrations, and it is
 *   the recovery path when a generated password was missed — setting a
 *   password you already know is idempotent, and nothing is printed.
 * - Otherwise a fresh random password on first run only, with the resulting
 *   connection string printed once to this process's own stdout — for a
 *   Vercel build that means the deployment's build log, not a chat
 *   transcript or a committed file.
 * - Once mm_app has LOGIN it is never rotated implicitly, so a redeploy
 *   cannot invalidate a DATABASE_URL another environment is already using.
 */
async function ensureAppRolePassword(pool: Pool, connection: ResolvedConnection): Promise<void> {
  const { rows } = await pool.query<{ rolcanlogin: boolean }>(
    "SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = 'mm_app'",
  );
  const role = rows[0];
  if (!role) {
    throw new Error(
      "mm_app role was not found after migrating — check drizzle/0001_row_level_security.sql ran.",
    );
  }

  // The username the app must connect as, which is not always just "mm_app":
  // a pooled Supabase connection routes by "<role>.<project-ref>".
  const appRoleName = poolerAwareRoleName("mm_app", connection.host, connection.user);
  const explicitPassword = process.env.MM_APP_DB_PASSWORD;

  if (explicitPassword) {
    // Applied on every run, not just the first. Setting a password you
    // already know is idempotent, and it's the escape hatch when the
    // generated one was missed — no secret is ever printed on this path.
    await pool.query(
      `ALTER ROLE mm_app WITH LOGIN PASSWORD '${escapeSqlStringLiteral(explicitPassword)}'`,
    );
    console.log(
      `[db] mm_app password set from MM_APP_DB_PASSWORD. ` +
        `Connect the app as "${appRoleName}" at ${connection.host}:${connection.port}.`,
    );
    return;
  }

  if (role.rolcanlogin) {
    console.log(
      `[db] mm_app already has LOGIN — not rotating its password. ` +
        `The app should connect as "${appRoleName}". If that password was lost, set ` +
        `MM_APP_DB_PASSWORD to a value you choose and redeploy to reset it.`,
    );
    return;
  }

  const password = generateSafePassword();
  await pool.query(`ALTER ROLE mm_app WITH LOGIN PASSWORD '${escapeSqlStringLiteral(password)}'`);

  const appUrl =
    `postgresql://${appRoleName}:${encodeURIComponent(password)}` +
    `@${connection.host}:${connection.port}/${connection.database}`;

  console.log("\n==================== ACTION REQUIRED ====================");
  console.log("mm_app now has LOGIN with a freshly generated password.");
  console.log("This is printed once, here only. Copy it now:\n");
  console.log(`  DATABASE_URL=${appUrl}\n`);
  console.log("In your hosting provider's environment variables:");
  console.log("  1. Keep the current admin connection string as DIRECT_DATABASE_URL");
  console.log("     (migrations use it).");
  console.log("  2. Set DATABASE_URL to the value above. The app's runtime traffic must");
  console.log("     use this role: unlike the admin/owner role it cannot bypass");
  console.log("     row-level security, which is what enforces tenant isolation.");
  console.log("  3. Redeploy.");
  console.log("");
  console.log("Prefer not to have a password in a build log? Set MM_APP_DB_PASSWORD to a");
  console.log("value you choose instead and redeploy — it is applied without being printed.");
  console.log("=========================================================\n");
}

/**
 * Actually connects with the application's credentials.
 *
 * Everything else here validates the migration connection, which says
 * nothing about the runtime one — they are different strings, and a
 * mismatch between the password written to mm_app and the password in
 * DATABASE_URL produces a perfectly green build followed by
 * "password authentication failed" on every request. Since both strings are
 * already in hand, proving the app's works is one round trip.
 */
async function verifyRuntimeConnection(runtime: ResolvedConnection): Promise<void> {
  const pool = new Pool({
    connectionString: runtime.connectionString,
    ssl: runtime.ssl,
    max: 1,
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 15_000),
  });
  try {
    const { rows } = await pool.query<{ user: string }>("SELECT current_user AS user");
    console.log(`[db] Verified: the application can connect as "${rows[0]?.user}".`);
  } catch (error) {
    console.warn(
      `\n[db] WARNING: the application's own credentials DO NOT WORK.\n` +
        `     ${explainConnectionError(error, runtime)}\n` +
        `     The build will still succeed, but every request will fail at runtime.\n` +
        `\n` +
        `     If MM_APP_DB_PASSWORD is set, the password in ${runtime.source} must match it\n` +
        `     exactly — this script rewrites mm_app's password from MM_APP_DB_PASSWORD on\n` +
        `     every build, so the two drift apart the moment they differ. Check both are\n` +
        `     set, identical, and present in the same environment scope.\n` +
        `\n` +
        `     Any character in the password that is special in a URL (@ : / ? # %) must be\n` +
        `     percent-encoded inside ${runtime.source}, or choose an alphanumeric password\n` +
        `     to sidestep the question entirely.\n`,
    );
  } finally {
    await pool.end();
  }
}

/**
 * Reports what the *application* will connect as, while we still have a build
 * log to say it in, and returns that connection so it can be verified.
 *
 * Catches an unreachable runtime host (e.g. an IPv6-only Supabase host) and
 * the app connecting as the schema owner — PostgreSQL exempts superusers and
 * table owners from RLS, so that configuration disables tenant isolation
 * entirely while appearing to work perfectly.
 */
function reportRuntimeConnection(migration: ResolvedConnection): ResolvedConnection | null {
  let runtime: ResolvedConnection;
  try {
    runtime = resolveConnection("runtime");
  } catch (error) {
    const appRoleName = poolerAwareRoleName("mm_app", migration.host, migration.user);
    console.warn(
      `\n[db] WARNING: the application's own connection is not usable yet: ` +
        `${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n` +
        `     The build will still succeed, but every request will fail at runtime.\n` +
        `\n` +
        `     Set DATABASE_URL to the mm_app role (NOT the admin connection, which is\n` +
        `     exempt from row-level security). It should look like:\n` +
        `\n` +
        `       postgresql://${appRoleName}:<mm_app-password>` +
        `@${migration.host}:${migration.port}/${migration.database}\n` +
        `\n` +
        `     If you do not have the mm_app password, set MM_APP_DB_PASSWORD to a value\n` +
        `     you choose and redeploy — this script applies it on every run, so that\n` +
        `     resets the role to a password you know without printing anything.\n`,
    );
    return null;
  }

  console.log(
    `[db] Application will connect to ${runtime.host}:${runtime.port}/${runtime.database} ` +
      `as "${runtime.user}" (from ${runtime.source}).`,
  );

  for (const warning of runtime.warnings) {
    console.warn(`[db] WARNING: ${warning}`);
  }

  if (runtime.user === migration.user && runtime.host === migration.host) {
    console.warn(
      `\n[db] WARNING: ${runtime.source} connects as "${runtime.user}" — the same role that ` +
        `owns the schema.\n` +
        `     PostgreSQL exempts table owners from row-level security, so tenant isolation ` +
        `is NOT enforced\n` +
        `     for the running application in this configuration. Point ${runtime.source} at the ` +
        `mm_app role instead.\n`,
    );
  }

  return runtime;
}

async function main() {
  const connection = resolveConnection("migration");

  console.log(
    `[db] Migrating ${connection.database} at ${connection.host}:${connection.port} ` +
      `as "${connection.user}" (from ${connection.source}, ssl=${connection.ssl ? "on" : "off"}).`,
  );
  for (const warning of connection.warnings) {
    console.warn(`[db] WARNING: ${warning}`);
  }

  const pool = new Pool({
    connectionString: connection.connectionString,
    ssl: connection.ssl,
    max: 1,
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 15_000),
  });

  try {
    await preflight(pool, connection);
    console.log("[db] Connected. Running migrations...");
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.log("[db] Migrations complete.");
    await ensureAppRolePassword(pool, connection);
    const runtime = reportRuntimeConnection(connection);
    if (runtime) {
      await verifyRuntimeConnection(runtime);
    }

    // Everything else the running app needs (auth secret, etc.) — a green
    // build otherwise says nothing about whether requests will succeed.
    const envProblems = checkRuntimeEnv(process.env);
    if (envProblems.length > 0) {
      console.warn(formatEnvProblems(envProblems));
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  if (error instanceof DatabaseConfigurationError) {
    // Already an operator-readable explanation; a stack trace adds only noise.
    console.error(`\n[db] Migration aborted.\n\n${error.message}\n`);
  } else {
    console.error("[db] Migration failed:", error);
  }
  process.exit(1);
});
