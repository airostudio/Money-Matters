/**
 * Resolves, validates and repairs the PostgreSQL connection configuration.
 *
 * This is deliberately a pure module (no `server-only`, no side effects at
 * import time) so it is unit-testable and so merely *importing* the database
 * client never requires a reachable database — see src/db/client.ts.
 *
 * Everything here is written to fail with a message an operator can act on
 * without ever printing the password. A connection string is a credential;
 * `redactConnectionString()` is the only sanctioned way to log one.
 */

export type ConnectionPurpose = "runtime" | "migration";

/**
 * Just the shape we actually read. Deliberately looser than
 * `NodeJS.ProcessEnv` (which Next augments with required keys) so callers —
 * tests especially — can pass a plain object of the vars under test.
 */
export type EnvLike = Record<string, string | undefined>;

/**
 * Env vars checked, in order. The list covers Vercel's Supabase/Postgres
 * integration names as well as our own, so a project wired up by that
 * integration works without renaming anything by hand.
 *
 * `migration` prefers explicitly non-pooled/direct connections: schema DDL,
 * CREATE ROLE and session-level settings misbehave through a
 * transaction-mode pooler.
 */
const CANDIDATE_ENV_VARS: Record<ConnectionPurpose, readonly string[]> = {
  runtime: ["DATABASE_URL", "POSTGRES_URL", "SUPABASE_DB_URL", "POSTGRES_PRISMA_URL"],
  migration: [
    "DIRECT_DATABASE_URL",
    "POSTGRES_URL_NON_POOLING",
    "DATABASE_URL",
    "POSTGRES_URL",
    "SUPABASE_DB_URL",
  ],
};

const VALID_SCHEMES = new Set(["postgres", "postgresql"]);

/** Substrings that mean someone pasted a template without filling it in. */
const PLACEHOLDER_MARKERS = [
  "[YOUR-PASSWORD]",
  "[YOUR_PASSWORD]",
  "YOUR-PASSWORD",
  "<password>",
  "<PASSWORD>",
  "your-password",
  "[PASSWORD]",
  "[db-password]",
  "change-me",
  "CHANGE_ME",
];

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

export interface ParsedConnection {
  scheme: string;
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  query: string;
}

/**
 * Splits a Postgres URI by hand rather than with `new URL()`.
 *
 * `new URL()` rejects the whole string when the password contains characters
 * that are illegal in userinfo (`[`, `]`, spaces, and — very commonly for
 * generated database passwords — `@`, `/`, `#`, `?`). That rejection is what
 * produced the opaque `TypeError: Invalid URL` this module exists to
 * replace: we need to reach *into* the string to find and fix the offending
 * part, which means parsing it before it is valid.
 *
 * Userinfo is taken as everything before the LAST `@` in the authority
 * section (the standard disambiguation when a password itself contains `@`),
 * and user/password split on the FIRST `:`.
 */
export function parseConnectionString(raw: string): ParsedConnection {
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
  if (!schemeMatch) {
    throw new DatabaseConfigurationError(
      'Connection string does not start with "postgresql://" (or "postgres://").',
    );
  }
  const scheme = schemeMatch[1]!.toLowerCase();
  const rest = raw.slice(schemeMatch[0].length);

  // The userinfo boundary has to be found BEFORE the authority boundary: a
  // password may legally contain "/" and "?", so looking for those first
  // would slice the string in the middle of the credentials.
  const atIndex = findUserinfoBoundary(rest);
  const userinfo = atIndex >= 0 ? rest.slice(0, atIndex) : "";
  const afterUserinfo = atIndex >= 0 ? rest.slice(atIndex + 1) : rest;

  // Only now: the authority ends at the first "/" or "?" of what remains.
  const boundaries = [afterUserinfo.indexOf("/"), afterUserinfo.indexOf("?")].filter((i) => i >= 0);
  const authorityEnd = boundaries.length > 0 ? Math.min(...boundaries) : afterUserinfo.length;
  const hostinfo = afterUserinfo.slice(0, authorityEnd);
  const tail = afterUserinfo.slice(authorityEnd);

  const colonIndex = userinfo.indexOf(":");
  const user = colonIndex >= 0 ? userinfo.slice(0, colonIndex) : userinfo;
  const password = colonIndex >= 0 ? userinfo.slice(colonIndex + 1) : "";

  // Host may be a bracketed IPv6 literal, e.g. [2406:da18::1]:5432.
  let host: string;
  let portText: string;
  if (hostinfo.startsWith("[")) {
    const closing = hostinfo.indexOf("]");
    if (closing < 0) {
      throw new DatabaseConfigurationError("Connection string has an unterminated IPv6 host.");
    }
    host = hostinfo.slice(0, closing + 1);
    portText = hostinfo.slice(closing + 1).replace(/^:/, "");
  } else {
    const hostColon = hostinfo.lastIndexOf(":");
    host = hostColon >= 0 ? hostinfo.slice(0, hostColon) : hostinfo;
    portText = hostColon >= 0 ? hostinfo.slice(hostColon + 1) : "";
  }

  const queryIndex = tail.indexOf("?");
  const pathPart = queryIndex >= 0 ? tail.slice(0, queryIndex) : tail;
  const query = queryIndex >= 0 ? tail.slice(queryIndex) : "";

  return {
    scheme,
    user: decodeComponent(user),
    password: decodeComponent(password),
    host,
    port: portText ? Number(portText) : 5432,
    database: pathPart.replace(/^\//, ""),
    query,
  };
}

const PLAUSIBLE_HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(:\d+)?$/;

/**
 * Finds the "@" that separates userinfo from host, returning -1 when there
 * is no userinfo.
 *
 * A password may contain "@", "/" and "?", so this scans right-to-left and
 * accepts the first candidate whose following segment actually looks like a
 * host (and, when the string has a path, yields a non-empty database name).
 * That resolves both `postgres:p@ss@host/db` — where the naive first "@" is
 * wrong — and `postgres@host/db@name`, where the naive last "@" is wrong.
 *
 * Known limitation: a *database name* containing "@" alongside a password
 * containing "@" is ambiguous and not supported.
 */
function findUserinfoBoundary(rest: string): number {
  const hasPath = rest.includes("/");
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i] !== "@") continue;
    const after = rest.slice(i + 1);
    const boundaries = [after.indexOf("/"), after.indexOf("?")].filter((b) => b >= 0);
    const end = boundaries.length > 0 ? Math.min(...boundaries) : after.length;
    if (!PLAUSIBLE_HOST.test(after.slice(0, end))) continue;
    const database = after.slice(end).replace(/^\//, "").split("?")[0] ?? "";
    if (hasPath && database === "") continue;
    return i;
  }
  return -1;
}

/**
 * Percent-decodes a URI component, falling back to the raw text when it
 * isn't valid escaping. A password of `50%off` is not "50", it is literally
 * `50%off` — decodeURIComponent throws on it, and treating that as fatal
 * would reject a perfectly usable password.
 */
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Rebuilds a connection string with the credentials correctly percent-encoded.
 * This is the actual repair: a Supabase password containing `@`, `[`, `#`,
 * `?` or a space is legal as a *password* but illegal raw inside a URI, and
 * every Postgres driver parses connection strings as URIs.
 */
export function normalizeConnectionString(raw: string): string {
  const trimmed = stripWrappingQuotes(raw.trim());
  const parsed = parseConnectionString(trimmed);

  const credentials = parsed.password
    ? `${encodeURIComponent(parsed.user)}:${encodeURIComponent(parsed.password)}@`
    : parsed.user
      ? `${encodeURIComponent(parsed.user)}@`
      : "";

  return `${parsed.scheme}://${credentials}${parsed.host}:${parsed.port}/${parsed.database}${parsed.query}`;
}

/**
 * Copy-pasting out of a `.env` file or a shell often carries the quotes along;
 * Vercel stores the value verbatim, quotes included, and every driver then
 * treats `"postgresql` as the scheme.
 */
function stripWrappingQuotes(value: string): string {
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length >= 2 && (first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

/** Safe for logs: keeps everything an operator needs, drops the password. */
export function redactConnectionString(raw: string): string {
  try {
    const parsed = parseConnectionString(stripWrappingQuotes(raw.trim()));
    const user = parsed.user || "(no user)";
    const secret = parsed.password ? "***" : "(no password)";
    return `${parsed.scheme}://${user}:${secret}@${parsed.host}:${parsed.port}/${parsed.database}`;
  } catch {
    return "(unparseable connection string — value withheld)";
  }
}

/**
 * Explains, in operator terms, why a connection string can't be used.
 * Returns null when nothing is obviously wrong. Never includes the password.
 */
export function diagnoseConnectionString(raw: string): string | null {
  const value = stripWrappingQuotes(raw.trim());

  if (value === "") return "the value is empty";

  const placeholder = PLACEHOLDER_MARKERS.find((marker) =>
    value.toLowerCase().includes(marker.toLowerCase()),
  );
  if (placeholder) {
    return `it still contains the placeholder "${placeholder}" — the template was saved without substituting the real password`;
  }

  if (/\s/.test(value)) {
    return "it contains whitespace or a line break (often an artifact of copy-paste); remove it, or percent-encode a space in the password as %20";
  }

  let parsed: ParsedConnection;
  try {
    parsed = parseConnectionString(value);
  } catch (error) {
    return error instanceof Error ? error.message : "it could not be parsed";
  }

  if (!VALID_SCHEMES.has(parsed.scheme)) {
    return `the scheme is "${parsed.scheme}://" — expected "postgresql://" or "postgres://"`;
  }
  if (!parsed.host) return "no host was found";
  if (!Number.isFinite(parsed.port) || parsed.port <= 0) {
    return "the port is not a number";
  }
  if (!parsed.database) return "no database name was found after the host";
  if (!parsed.user) return "no username was found before the password";

  // Final proof: the repaired string must survive the driver's own parser.
  try {
    // eslint-disable-next-line no-new
    new URL(normalizeConnectionString(value));
  } catch {
    return "it could not be normalized into a valid URI even after percent-encoding the credentials";
  }

  return null;
}

/**
 * Supabase moved direct-connection hostnames (`db.<ref>.supabase.co`) to
 * IPv6-only in 2024; a dedicated IPv4 address is a paid add-on. Vercel's
 * build containers and serverless functions are IPv4-only, so that hostname
 * fails there with ENETUNREACH/ENOTFOUND no matter how correct the
 * credentials are. The pooler hostnames are dual-stack, which is why they're
 * the right answer for anything running on Vercel.
 */
export function isSupabaseDirectHost(host: string): boolean {
  return /^db\.[a-z0-9]+\.supabase\.(co|com)$/i.test(host);
}

/**
 * Supabase's connection pooler (Supavisor) routes by tenant using a
 * `<role>.<project-ref>` username — which is why a pooled connection string
 * says `postgres.abcdefghijklmnop` where the direct one just says
 * `postgres`. Any *other* role has to follow the same convention, so a bare
 * `mm_app` is rejected by the pooler even though the role exists.
 *
 * Derives the correct pooled username for `role` by reusing the project ref
 * from the connection we already have. Returns `role` unchanged when the
 * connection isn't pooled.
 */
export function poolerAwareRoleName(role: string, host: string, currentUser: string): string {
  if (!/(^|\.)pooler\./i.test(host)) return role;
  const projectRef = /^[^.]+\.(.+)$/.exec(currentUser)?.[1];
  return projectRef ? `${role}.${projectRef}` : role;
}

export function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

export interface SslConfig {
  rejectUnauthorized: boolean;
  ca?: string;
}

/**
 * Local Postgres runs without TLS; every hosted provider requires it.
 *
 * Without a CA to check against, `rejectUnauthorized: false` gives an
 * encrypted-but-unauthenticated channel — it stops passive interception, not
 * an active MITM. Supply the provider's CA via DATABASE_CA_CERT to get full
 * verification; see docs/security.md.
 */
export function resolveSsl(host: string, env: EnvLike): SslConfig | false {
  if (isLocalHost(host)) return false;
  const ca = env.DATABASE_CA_CERT?.trim();
  if (ca) return { rejectUnauthorized: true, ca };
  return { rejectUnauthorized: false };
}

export interface ResolvedConnection {
  /** Repaired, driver-safe connection string. */
  connectionString: string;
  /** Which environment variable it came from — useful when several are set. */
  source: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: SslConfig | false;
  /** Non-fatal warnings worth surfacing in logs. */
  warnings: string[];
}

/**
 * The single entry point every database consumer goes through.
 * Throws DatabaseConfigurationError with an actionable message rather than
 * letting a driver-level TypeError surface with no context.
 */
export function resolveConnection(
  purpose: ConnectionPurpose,
  env: EnvLike = process.env,
): ResolvedConnection {
  const candidates = CANDIDATE_ENV_VARS[purpose];
  const source = candidates.find((name) => (env[name] ?? "").trim() !== "");

  if (!source) {
    if (purpose === "runtime") {
      const derived = deriveRuntimeConnection(env);
      if (derived) return derived;
    }
    throw new DatabaseConfigurationError(
      `No database connection string found for ${purpose}. Set one of: ${candidates.join(", ")}.` +
        (purpose === "runtime"
          ? `\nAlternatively, set MM_APP_DB_PASSWORD and leave DATABASE_URL unset — the ` +
            `application's connection is then derived from it and the migration connection.`
          : ""),
    );
  }

  const raw = env[source]!;
  const problem = diagnoseConnectionString(raw);
  if (problem) {
    throw new DatabaseConfigurationError(
      `${source} is not a usable PostgreSQL connection string: ${problem}.\n` +
        `Expected the shape postgresql://USER:PASSWORD@HOST:PORT/DATABASE\n` +
        `(the password is never printed by this tool; nothing above was read from it).`,
    );
  }

  let connectionString = normalizeConnectionString(raw);
  let parsed = parseConnectionString(connectionString);
  const warnings: string[] = [];

  // When MM_APP_DB_PASSWORD is set, the migration writes it to the mm_app
  // role on every run — so it *is* that role's password, and a different
  // password embedded in a connection string for the same role is stale by
  // construction rather than an alternative worth honouring. Substituting it
  // removes an entire failure mode: the same secret maintained in two places,
  // drifting apart into a green build where every request fails
  // "password authentication failed". Only the password is replaced; host,
  // port, database and any other role are left exactly as configured.
  const appPassword = env.MM_APP_DB_PASSWORD?.trim();
  if (
    appPassword &&
    baseRoleName(parsed.user) === APP_ROLE &&
    parsed.password !== appPassword
  ) {
    connectionString =
      `${parsed.scheme}://${encodeURIComponent(parsed.user)}:${encodeURIComponent(appPassword)}` +
      `@${parsed.host}:${parsed.port}/${parsed.database}${parsed.query}`;
    parsed = parseConnectionString(connectionString);
    warnings.push(
      `${source} carried a different password for the "${APP_ROLE}" role than ` +
        `MM_APP_DB_PASSWORD. MM_APP_DB_PASSWORD was used, because the migration writes it ` +
        `to the role on every run and is therefore authoritative. Remove the password from ` +
        `${source} (or unset ${source} entirely) to keep one copy of it.`,
    );
  }

  if (isSupabaseDirectHost(parsed.host)) {
    warnings.push(
      `${source} points at Supabase's direct-connection host (${parsed.host}), which is IPv6-only. ` +
        `IPv4-only platforms — Vercel included — cannot reach it. Use the Session pooler ` +
        `connection string from Supabase (Project Settings -> Database -> Connection string -> ` +
        `Session pooler), which is dual-stack.`,
    );
  }

  return {
    connectionString,
    source,
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    ssl: resolveSsl(parsed.host, env),
    warnings,
  };
}

/** The restricted role the application connects as. See docs/security.md §2. */
export const APP_ROLE = "mm_app";

/**
 * The underlying PostgreSQL role behind a connection username. Supabase's
 * pooler routes by `<role>.<project-ref>`, so the username carries a suffix
 * that is not part of the role's actual name.
 */
export function baseRoleName(user: string): string {
  return user.split(".")[0] ?? user;
}

/** Admin/owner connections, in preference order, that a runtime one can be derived from. */
const ADMIN_ENV_VARS = ["DIRECT_DATABASE_URL", "POSTGRES_URL_NON_POOLING"] as const;

/**
 * Builds the application's connection from MM_APP_DB_PASSWORD plus the
 * migration connection's host/port/database.
 *
 * Otherwise the same password has to be kept in sync in two places —
 * MM_APP_DB_PASSWORD (which the migration writes to the role) and the
 * password embedded in DATABASE_URL — and the moment they differ the build
 * is green while every request fails "password authentication failed". They
 * cannot drift if there is only one of them.
 *
 * Only used when no runtime connection string is set at all: an explicit
 * DATABASE_URL always wins, so this never silently overrides a deliberate
 * choice. The derived connection uses the restricted role, never the admin
 * one, so row-level security still applies.
 */
function deriveRuntimeConnection(env: EnvLike): ResolvedConnection | null {
  const password = env.MM_APP_DB_PASSWORD?.trim();
  if (!password) return null;

  const adminVar = ADMIN_ENV_VARS.find((name) => (env[name] ?? "").trim() !== "");
  if (!adminVar) return null;
  if (diagnoseConnectionString(env[adminVar]!)) return null;

  const admin = parseConnectionString(normalizeConnectionString(env[adminVar]!));
  const user = poolerAwareRoleName(APP_ROLE, admin.host, admin.user);

  const warnings: string[] = [];
  if (isSupabaseDirectHost(admin.host)) {
    warnings.push(
      `The derived application connection inherits the IPv6-only host ${admin.host} from ` +
        `${adminVar}; IPv4-only platforms cannot reach it.`,
    );
  }

  return {
    connectionString:
      `${admin.scheme}://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
      `@${admin.host}:${admin.port}/${admin.database}${admin.query}`,
    source: `derived from MM_APP_DB_PASSWORD + ${adminVar}`,
    host: admin.host,
    port: admin.port,
    database: admin.database,
    user,
    ssl: resolveSsl(admin.host, env),
    warnings,
  };
}

/**
 * Turns a driver-level connection failure into something that names the
 * likely cause. These codes otherwise surface as bare errno strings in a
 * build log with no indication of which knob to turn.
 */
export function explainConnectionError(error: unknown, connection: ResolvedConnection): string {
  const code = (error as { code?: string } | null)?.code;
  const target = `${connection.host}:${connection.port}`;

  switch (code) {
    case "ENETUNREACH":
    case "EHOSTUNREACH":
      return isSupabaseDirectHost(connection.host)
        ? `Cannot reach ${target}: this is Supabase's IPv6-only direct-connection host and this platform is IPv4-only. ` +
            `Switch ${connection.source} to the Session pooler connection string (Supabase -> Project Settings -> Database).`
        : `Cannot reach ${target} (network unreachable). Check the host is correct and reachable from this network.`;
    case "ENOTFOUND":
      return `Host "${connection.host}" does not resolve. Check for a typo, or that the project still exists.`;
    case "ECONNREFUSED":
      return `${target} refused the connection. Check the port and that the database is running.`;
    case "ETIMEDOUT":
      return `Connecting to ${target} timed out — usually a firewall or IP-allowlist rule.`;
    case "28P01":
      return `Password authentication failed for user "${connection.user}". The password in ${connection.source} is wrong.`;
    case "3D000":
      return `Database "${connection.database}" does not exist on ${target}.`;
    case "28000":
      return `Role "${connection.user}" is not permitted to connect to ${target}.`;
    default:
      return `Could not connect to ${target} as "${connection.user}"${code ? ` (${code})` : ""}.`;
  }
}
