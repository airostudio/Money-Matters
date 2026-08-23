import "server-only";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { resolveConnection } from "./connection";

declare global {
  // eslint-disable-next-line no-var
  var __mmPgPool: Pool | undefined;
}

let cachedDb: NodePgDatabase<typeof schema> | undefined;
let cachedPool: Pool | undefined;

function createPool(): Pool {
  const connection = resolveConnection("runtime");
  for (const warning of connection.warnings) {
    console.warn(`[db] ${warning}`);
  }

  return new Pool({
    connectionString: connection.connectionString,
    ssl: connection.ssl,
    // Serverless invocations are short-lived and numerous; a small ceiling
    // per instance keeps us well inside a pooler's connection limit.
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 10_000),
    idleTimeoutMillis: 30_000,
  });
}

function getPool(): Pool {
  if (!cachedPool) {
    // Reused across hot reloads in dev so we don't exhaust Postgres connections.
    cachedPool = globalThis.__mmPgPool ?? createPool();
    if (process.env.NODE_ENV !== "production") {
      globalThis.__mmPgPool = cachedPool;
    }
  }
  return cachedPool;
}

function getDb(): NodePgDatabase<typeof schema> {
  cachedDb ??= drizzle(getPool(), { schema });
  return cachedDb;
}

/**
 * The connection is established on first *use*, not on import.
 *
 * This matters beyond tidiness: `next build` imports every route module to
 * collect page data, so an eagerly-created Pool made a valid production build
 * impossible without a reachable database — the build failed at import time
 * with "DATABASE_URL is not set" before rendering anything. Behind this proxy,
 * a route that never queries never connects.
 */
export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, property, _receiver) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[property];
    // Bind so Drizzle's internals keep their real `this` rather than the proxy.
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export type Database = NodePgDatabase<typeof schema>;

/** Closes the pool. Used by tests and one-shot scripts so the process can exit. */
export async function closeDatabase(): Promise<void> {
  const pool = cachedPool ?? globalThis.__mmPgPool;
  if (pool) {
    await pool.end();
  }
  cachedPool = undefined;
  cachedDb = undefined;
  globalThis.__mmPgPool = undefined;
}
