import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { checkOptionalFeatures, checkRuntimeEnv, formatOptionalFeatureNotes } from "@/lib/runtime-env";

const VALID_DB = "postgresql://mm_app:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres";
const COMPLETE = { DATABASE_URL: VALID_DB, NEXTAUTH_SECRET: "a".repeat(32), VERCEL: "1" };

describe("optional-feature notes (webhooks key) never turn a good environment into a failing one", () => {
  it("the missing key is a NOTE about a disabled feature, and checkRuntimeEnv still passes a complete environment", () => {
    expect(checkRuntimeEnv(COMPLETE)).toEqual([]);
    const notes = checkOptionalFeatures(COMPLETE);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.variable).toBe("WEBHOOK_SECRET_ENCRYPTION_KEY");
    expect(notes[0]!.note).toMatch(/webhooks are disabled/i);
    expect(notes[0]!.note).toMatch(/openssl rand -base64 32/);
    expect(formatOptionalFeatureNotes(notes)).toMatch(/NOTE \(optional feature\)/);
    expect(formatOptionalFeatureNotes(notes)).not.toMatch(/WARNING/);
  });

  it("a malformed key is noted without ever echoing its value; a valid one is silent", () => {
    const bad = checkOptionalFeatures({ ...COMPLETE, WEBHOOK_SECRET_ENCRYPTION_KEY: "hunter2-not-a-key" });
    expect(bad).toHaveLength(1);
    expect(JSON.stringify(bad)).not.toContain("hunter2");
    expect(formatOptionalFeatureNotes(bad)).not.toContain("hunter2");
    expect(checkOptionalFeatures({ ...COMPLETE, WEBHOOK_SECRET_ENCRYPTION_KEY: randomBytes(32).toString("base64") })).toEqual([]);
  });
});
