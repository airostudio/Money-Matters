import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { adminDb, closeTestPools } from "../../helpers/db";
import { db } from "@/db/client";
import { healUnscopedDenyAllTables } from "@/db/isolation-audit";

// Reproduces the production fault: the platform auto-enabled RLS on a table the schema leaves to GRANTs, so every
// mm_app write failed with "new row violates row-level security policy" (platform_admin_audit_logs, archive action).
describe("healUnscopedDenyAllTables", () => {
  afterAll(async () => {
    await adminDb().execute(sql`DROP TABLE IF EXISTS public.zz_heal_unscoped, public.zz_heal_scoped`);
    await closeTestPools();
  });

  it("restores mm_app writes on an unscoped RLS-enabled table with no policy, leaves scoped tables alone, and is idempotent", async () => {
    const admin = adminDb();
    await admin.execute(sql`DROP TABLE IF EXISTS public.zz_heal_unscoped, public.zz_heal_scoped`);
    await admin.execute(sql`CREATE TABLE public.zz_heal_unscoped (id int PRIMARY KEY)`);
    await admin.execute(sql`GRANT SELECT, INSERT ON public.zz_heal_unscoped TO mm_app`);
    await admin.execute(sql`ALTER TABLE public.zz_heal_unscoped ENABLE ROW LEVEL SECURITY`);
    await admin.execute(sql`CREATE TABLE public.zz_heal_scoped (id int PRIMARY KEY, organization_id uuid)`);
    await admin.execute(sql`GRANT SELECT, INSERT ON public.zz_heal_scoped TO mm_app`);
    await admin.execute(sql`ALTER TABLE public.zz_heal_scoped ENABLE ROW LEVEL SECURITY`);

    await expect(db.execute(sql`INSERT INTO public.zz_heal_unscoped (id) VALUES (1)`)).rejects.toThrow();

    const pool = { query: (text: string) => admin.$client.query(text) };
    const healed = await healUnscopedDenyAllTables(pool as never);
    expect(healed).toContain("zz_heal_unscoped");
    expect(healed).not.toContain("zz_heal_scoped");

    await db.execute(sql`INSERT INTO public.zz_heal_unscoped (id) VALUES (1)`);
    // GRANTs still bound the role: no DELETE was granted.
    await expect(db.execute(sql`DELETE FROM public.zz_heal_unscoped`)).rejects.toThrow();

    expect(await healUnscopedDenyAllTables(pool as never)).not.toContain("zz_heal_unscoped");
  });
});
