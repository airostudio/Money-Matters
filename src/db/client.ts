import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __mmPgPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }
  return new Pool({ connectionString });
}

// Reused across hot reloads in dev so we don't exhaust Postgres connections.
const pool = globalThis.__mmPgPool ?? createPool();
if (process.env.NODE_ENV !== "production") {
  globalThis.__mmPgPool = pool;
}

export const db = drizzle(pool, { schema });
export type Database = typeof db;
export { pool };
