import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const SAFE_PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateSafePassword(length = 32): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += SAFE_PASSWORD_ALPHABET[bytes[i]! % SAFE_PASSWORD_ALPHABET.length];
  }
  return out;
}

// Safe because the value is either our own generated alphanumeric-only
// string, or (for the explicit-password path) still needs escaping since an
// operator-supplied password could contain a quote.
function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * drizzle/0001_row_level_security.sql creates `mm_app` with NOLOGIN and no
 * password — a fixed password committed to source control is a real
 * vulnerability the moment this runs against an internet-reachable
 * database (mm_app can set app.current_org_id to anything, so a leaked
 * password is a cross-tenant read of the whole database). This is the one
 * place a real credential gets attached to the role, and it never touches
 * git:
 *
 * - If MM_APP_DB_PASSWORD is set, use it verbatim (local dev: .env pins
 *   this to a fixed value so `DATABASE_URL` in .env stays valid across
 *   re-migrations).
 * - Otherwise, generate a fresh random password and print the resulting
 *   connection string once, to this process's stdout only — for a Vercel
 *   build, that means it lands in the deployment's build log, not in any
 *   chat transcript or committed file.
 * - Idempotent: if mm_app already has LOGIN enabled (a password was
 *   already set by a prior run), this is a no-op — it never silently
 *   rotates a password a deploy might already be depending on.
 */
async function ensureAppRolePassword(pool: Pool, connectionString: string) {
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
    console.log("mm_app already has LOGIN enabled — leaving its password as-is (not rotating).");
    return;
  }

  const explicitPassword = process.env.MM_APP_DB_PASSWORD;
  const password = explicitPassword ?? generateSafePassword();

  await pool.query(`ALTER ROLE mm_app WITH LOGIN PASSWORD '${escapeSqlStringLiteral(password)}'`);

  if (explicitPassword) {
    console.log("mm_app password set from MM_APP_DB_PASSWORD.");
    return;
  }

  const adminUrl = new URL(connectionString);
  const appUrl = `postgresql://mm_app:${password}@${adminUrl.host}${adminUrl.pathname}${adminUrl.search}`;
  console.log("\n=== mm_app now has LOGIN enabled with a freshly generated password ===");
  console.log("Printed once, here only — not stored anywhere else. Copy it now:");
  console.log(`  DATABASE_URL=${appUrl}`);
  console.log(
    "Set that as this project's DATABASE_URL (move the current admin connection string to",
  );
  console.log("DIRECT_DATABASE_URL instead, so future migrations keep using it), then redeploy.");
  console.log("======================================================================\n");
}

/**
 * Applies pending migrations, including the hand-authored RLS/grants
 * migration (drizzle/0001_row_level_security.sql) which creates the
 * restricted `mm_app` role the application runtime connects as, then
 * provisions that role's password (see ensureAppRolePassword above).
 *
 * Must run against DIRECT_DATABASE_URL (a superuser/owner connection) — the
 * restricted `mm_app` role has no privilege to CREATE ROLE or ALTER TABLE.
 */
async function main() {
  const connectionString = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DIRECT_DATABASE_URL (or DATABASE_URL) must be set to run migrations.");
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");

  await ensureAppRolePassword(pool, connectionString);

  await pool.end();
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
