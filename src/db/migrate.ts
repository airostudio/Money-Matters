import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  DatabaseConfigurationError,
  explainConnectionError,
  resolveConnection,
  type ResolvedConnection,
} from "./connection";

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
 * - MM_APP_DB_PASSWORD if provided (local dev pins this so .env's connection
 *   strings stay valid across re-migrations).
 * - Otherwise a fresh random password, with the resulting connection string
 *   printed once to this process's own stdout — for a Vercel build that means
 *   the deployment's build log, not a chat transcript or a committed file.
 * - Idempotent: once mm_app has LOGIN it is never rotated, so a redeploy
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

  if (role.rolcanlogin) {
    console.log("[db] mm_app already has LOGIN — leaving its password as-is (not rotating).");
    return;
  }

  const explicitPassword = process.env.MM_APP_DB_PASSWORD;
  const password = explicitPassword ?? generateSafePassword();

  await pool.query(`ALTER ROLE mm_app WITH LOGIN PASSWORD '${escapeSqlStringLiteral(password)}'`);

  if (explicitPassword) {
    console.log("[db] mm_app password set from MM_APP_DB_PASSWORD.");
    return;
  }

  const appUrl =
    `postgresql://mm_app:${encodeURIComponent(password)}` +
    `@${connection.host}:${connection.port}/${connection.database}`;

  console.log("\n==================== ACTION REQUIRED ====================");
  console.log("mm_app now has LOGIN with a freshly generated password.");
  console.log("This is printed once, here only. Copy it now:\n");
  console.log(`  DATABASE_URL=${appUrl}\n`);
  console.log("In your hosting provider's environment variables:");
  console.log(`  1. Rename the current DATABASE_URL to DIRECT_DATABASE_URL (migrations use it).`);
  console.log(`  2. Set DATABASE_URL to the value above (the app's runtime traffic uses it,`);
  console.log(`     and unlike the admin role it cannot bypass row-level security).`);
  console.log("  3. Redeploy.");
  console.log("=========================================================\n");
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
