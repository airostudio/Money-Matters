import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/**
 * Applies pending migrations, including the hand-authored RLS/grants
 * migration (drizzle/0001_row_level_security.sql) which creates the
 * restricted `mm_app` role the application runtime connects as.
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

  await pool.end();
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
