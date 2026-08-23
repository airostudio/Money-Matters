/**
 * Diagnoses the database connection without running migrations or mutating
 * anything. Run it anywhere the app runs — locally, or as a one-off command
 * in a hosting provider's shell — to find out exactly why a connection is
 * failing, in one round trip instead of a deploy cycle.
 *
 *   npm run db:doctor
 *
 * Never prints the password.
 */
import { Pool } from "pg";
import {
  DatabaseConfigurationError,
  diagnoseConnectionString,
  explainConnectionError,
  redactConnectionString,
  resolveConnection,
  type ConnectionPurpose,
} from "@/db/connection";

const CHECKED_VARS = [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_PRISMA_URL",
  "SUPABASE_DB_URL",
];

function reportEnvironment() {
  console.log("Environment variables:");
  let found = 0;
  for (const name of CHECKED_VARS) {
    const value = process.env[name];
    if (!value) continue;
    found += 1;
    const problem = diagnoseConnectionString(value);
    console.log(`  ${name}`);
    console.log(`    value:  ${redactConnectionString(value)}`);
    console.log(`    status: ${problem ? `INVALID — ${problem}` : "looks well-formed"}`);
  }
  if (found === 0) {
    console.log(`  none set (checked: ${CHECKED_VARS.join(", ")})`);
  }
  console.log("");
}

async function checkPurpose(purpose: ConnectionPurpose): Promise<boolean> {
  console.log(`--- ${purpose} connection ---`);
  let connection;
  try {
    connection = resolveConnection(purpose);
  } catch (error) {
    console.log(
      error instanceof DatabaseConfigurationError ? error.message : String(error),
      "\n",
    );
    return false;
  }

  console.log(`  source:   ${connection.source}`);
  console.log(`  target:   ${connection.host}:${connection.port}/${connection.database}`);
  console.log(`  user:     ${connection.user}`);
  console.log(`  ssl:      ${connection.ssl ? (connection.ssl.ca ? "on (CA verified)" : "on (unverified)") : "off"}`);
  for (const warning of connection.warnings) {
    console.log(`  WARNING:  ${warning}`);
  }

  const pool = new Pool({
    connectionString: connection.connectionString,
    ssl: connection.ssl,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const { rows } = await pool.query<{ version: string; user: string }>(
      "SELECT version() AS version, current_user AS user",
    );
    console.log(`  connected as "${rows[0]?.user}"`);
    console.log(`  server: ${rows[0]?.version?.split(",")[0]}`);
    console.log("  RESULT:   OK\n");
    return true;
  } catch (error) {
    console.log(`  RESULT:   FAILED — ${explainConnectionError(error, connection)}\n`);
    return false;
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log("\n=== Money Matters database doctor ===\n");
  reportEnvironment();

  const runtimeOk = await checkPurpose("runtime");
  const migrationOk = await checkPurpose("migration");

  if (runtimeOk && migrationOk) {
    console.log("Both connections are working.\n");
    process.exit(0);
  }
  console.log("At least one connection is not working — see above.\n");
  process.exit(1);
}

main().catch((error) => {
  console.error("db:doctor crashed:", error);
  process.exit(1);
});
