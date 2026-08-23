import { describe, expect, it } from "vitest";
import {
  DatabaseConfigurationError,
  diagnoseConnectionString,
  explainConnectionError,
  isSupabaseDirectHost,
  normalizeConnectionString,
  poolerAwareRoleName,
  parseConnectionString,
  redactConnectionString,
  resolveConnection,
  resolveSsl,
} from "@/db/connection";

const LOCAL = "postgresql://postgres:postgres@localhost:5432/money_matters";

describe("parseConnectionString", () => {
  it("parses a plain connection string", () => {
    const parsed = parseConnectionString(LOCAL);
    expect(parsed).toMatchObject({
      scheme: "postgresql",
      user: "postgres",
      password: "postgres",
      host: "localhost",
      port: 5432,
      database: "money_matters",
    });
  });

  it("splits on the LAST @ so a password containing @ still parses", () => {
    const parsed = parseConnectionString("postgresql://postgres:p@ss@db.example.com:5432/postgres");
    expect(parsed.password).toBe("p@ss");
    expect(parsed.host).toBe("db.example.com");
  });

  it("keeps a bracketed IPv6 host intact", () => {
    const parsed = parseConnectionString("postgresql://u:p@[2406:da18::1]:5432/postgres");
    expect(parsed.host).toBe("[2406:da18::1]");
    expect(parsed.port).toBe(5432);
  });

  it("defaults the port to 5432 when omitted", () => {
    expect(parseConnectionString("postgresql://u:p@example.com/postgres").port).toBe(5432);
  });

  it("preserves query parameters", () => {
    expect(parseConnectionString(`${LOCAL}?sslmode=require`).query).toBe("?sslmode=require");
  });

  it("rejects a string with no scheme", () => {
    expect(() => parseConnectionString("postgres.example.com/db")).toThrow(
      DatabaseConfigurationError,
    );
  });
});

describe("normalizeConnectionString", () => {
  it("leaves an already-valid string usable", () => {
    expect(() => new URL(normalizeConnectionString(LOCAL))).not.toThrow();
  });

  it("percent-encodes a password whose characters are illegal in a URI", () => {
    // Every one of these is a legal Postgres password but breaks `new URL()`
    // raw — which is what produced the opaque "Invalid URL" on deploy.
    for (const password of ["p@ss", "pa/ss", "pa?ss", "pa#ss", "pa ss", "[brackets]"]) {
      const raw = `postgresql://postgres:${password}@db.example.com:5432/postgres`;
      const normalized = normalizeConnectionString(raw);
      expect(() => new URL(normalized)).not.toThrow();
      expect(parseConnectionString(normalized).password).toBe(password);
    }
  });

  it("is idempotent — normalizing twice does not double-encode", () => {
    const once = normalizeConnectionString("postgresql://u:p@ss@example.com:5432/db");
    expect(normalizeConnectionString(once)).toBe(once);
  });

  it("strips quotes left over from copy-pasting a .env line", () => {
    expect(normalizeConnectionString(`"${LOCAL}"`)).toBe(normalizeConnectionString(LOCAL));
    expect(normalizeConnectionString(`'${LOCAL}'`)).toBe(normalizeConnectionString(LOCAL));
  });

  it("treats a literal % in a password as a literal, not broken escaping", () => {
    const raw = "postgresql://u:50%off@example.com:5432/db";
    expect(parseConnectionString(normalizeConnectionString(raw)).password).toBe("50%off");
  });
});

describe("diagnoseConnectionString", () => {
  it("accepts a well-formed string", () => {
    expect(diagnoseConnectionString(LOCAL)).toBeNull();
  });

  it("names the placeholder when a template was saved unedited", () => {
    // The exact value that broke the real deployment.
    const problem = diagnoseConnectionString(
      "postgresql://postgres:[YOUR-PASSWORD]@db.veoxnzvuqfwkratkrwvy.supabase.co:5432/postgres",
    );
    expect(problem).toContain("[YOUR-PASSWORD]");
  });

  it("flags an empty value", () => {
    expect(diagnoseConnectionString("   ")).toContain("empty");
  });

  it("flags stray whitespace or a trailing newline", () => {
    expect(diagnoseConnectionString(`${LOCAL}\n`.replace("/money_matters", " /money_matters"))).toContain(
      "whitespace",
    );
  });

  it("flags a wrong scheme", () => {
    expect(diagnoseConnectionString("mysql://u:p@example.com:3306/db")).toContain("scheme");
  });

  it("flags a missing database name", () => {
    expect(diagnoseConnectionString("postgresql://u:p@example.com:5432/")).toContain("database");
  });

  it("does not flag a password full of URI-illegal characters", () => {
    expect(diagnoseConnectionString("postgresql://u:a@b#c?d@example.com:5432/db")).toBeNull();
  });
});

describe("redactConnectionString", () => {
  it("never reveals the password but keeps what an operator needs", () => {
    const redacted = redactConnectionString("postgresql://postgres:sup3rSecret@host:5432/db");
    expect(redacted).not.toContain("sup3rSecret");
    expect(redacted).toContain("postgres");
    expect(redacted).toContain("host:5432");
  });

  it("withholds the value entirely when it cannot be parsed", () => {
    expect(redactConnectionString("total-nonsense")).toContain("withheld");
  });
});

describe("resolveSsl", () => {
  it("is off for local development", () => {
    expect(resolveSsl("localhost", {})).toBe(false);
    expect(resolveSsl("127.0.0.1", {})).toBe(false);
  });

  it("is on but unverified for a hosted database with no CA supplied", () => {
    expect(resolveSsl("db.example.supabase.co", {})).toEqual({ rejectUnauthorized: false });
  });

  it("verifies against a supplied CA", () => {
    const ssl = resolveSsl("db.example.supabase.co", { DATABASE_CA_CERT: "---CERT---" });
    expect(ssl).toEqual({ rejectUnauthorized: true, ca: "---CERT---" });
  });
});

describe("isSupabaseDirectHost", () => {
  it("recognises the IPv6-only direct host", () => {
    expect(isSupabaseDirectHost("db.veoxnzvuqfwkratkrwvy.supabase.co")).toBe(true);
  });

  it("does not flag the dual-stack pooler hosts", () => {
    expect(isSupabaseDirectHost("aws-0-ap-southeast-2.pooler.supabase.com")).toBe(false);
  });
});

describe("resolveConnection", () => {
  it("reads DATABASE_URL for runtime", () => {
    const resolved = resolveConnection("runtime", { DATABASE_URL: LOCAL });
    expect(resolved.source).toBe("DATABASE_URL");
    expect(resolved.database).toBe("money_matters");
  });

  it("prefers a direct/non-pooled connection for migrations", () => {
    const resolved = resolveConnection("migration", {
      DATABASE_URL: LOCAL,
      DIRECT_DATABASE_URL: LOCAL.replace("money_matters", "direct_db"),
    });
    expect(resolved.source).toBe("DIRECT_DATABASE_URL");
    expect(resolved.database).toBe("direct_db");
  });

  it("falls back to Vercel's Postgres integration variable names", () => {
    const resolved = resolveConnection("runtime", { POSTGRES_URL: LOCAL });
    expect(resolved.source).toBe("POSTGRES_URL");
  });

  it("names the variable and the problem when the value is unusable", () => {
    expect(() =>
      resolveConnection("runtime", { DATABASE_URL: "postgresql://u:[YOUR-PASSWORD]@h:5432/d" }),
    ).toThrow(/DATABASE_URL.*\[YOUR-PASSWORD\]/s);
  });

  it("lists what to set when nothing is configured", () => {
    expect(() => resolveConnection("runtime", {})).toThrow(/DATABASE_URL/);
  });

  it("warns about the IPv6-only Supabase host instead of failing", () => {
    const resolved = resolveConnection("runtime", {
      DATABASE_URL: "postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres",
    });
    expect(resolved.warnings.join(" ")).toMatch(/IPv6|pooler/i);
  });
});

describe("explainConnectionError", () => {
  const supabaseDirect = resolveConnection("runtime", {
    DATABASE_URL: "postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres",
  });

  it("points at the pooler when an IPv4-only platform cannot route to it", () => {
    const message = explainConnectionError({ code: "ENETUNREACH" }, supabaseDirect);
    expect(message).toMatch(/pooler/i);
  });

  it("names a bad password without echoing it", () => {
    const message = explainConnectionError({ code: "28P01" }, supabaseDirect);
    expect(message).toContain("authentication failed");
    expect(message).not.toContain("pw");
  });

  it("still says something useful for an unknown error", () => {
    expect(explainConnectionError(new Error("boom"), supabaseDirect)).toContain("Could not connect");
  });
});

describe("poolerAwareRoleName", () => {
  it("appends the project ref for a pooled Supabase connection", () => {
    // Supavisor routes by "<role>.<project-ref>", so a bare "mm_app" is
    // rejected by the pooler even though the role exists.
    expect(
      poolerAwareRoleName("mm_app", "aws-0-us-west-1.pooler.supabase.com", "postgres.veoxnzvuqfw"),
    ).toBe("mm_app.veoxnzvuqfw");
  });

  it("leaves the role alone on a direct (non-pooled) connection", () => {
    expect(poolerAwareRoleName("mm_app", "db.veoxnzvuqfw.supabase.co", "postgres")).toBe("mm_app");
    expect(poolerAwareRoleName("mm_app", "localhost", "postgres")).toBe("mm_app");
  });

  it("leaves the role alone if the pooled user carries no project ref", () => {
    expect(poolerAwareRoleName("mm_app", "aws-0-us-west-1.pooler.supabase.com", "postgres")).toBe(
      "mm_app",
    );
  });
});
