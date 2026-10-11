import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Permission } from "@/domain/permissions/roles";

/**
 * Reads a page's SOURCE and works out which permissions it needs in order to render, the way a person opening the page
 * would hit them: `deniedViewUnless(actor, "x")` gates, and every domain-service call on the page
 * (`ContactService.list(actor, ...)`) is mapped to the `assertPermission` at the top of that service method.
 *
 * Used by the structural tests that keep the Create menu and the palette's "Go to" / command gating honest: a menu
 * must not offer a destination whose own guard would refuse the role. Heuristic by design (it reads source, it does
 * not run the page), so conditional calls are listed per page in the tests as exemptions rather than guessed at.
 */
const SRC = path.resolve(__dirname, "../..");

export function pageFileFor(orgRelativeHref: string): string | null {
  const pathname = orgRelativeHref.split("?")[0] ?? "";
  const trimmed = pathname.replace(/^\//, "").replace(/\/$/, "");
  const candidate = path.join(SRC, "app/[orgSlug]", trimmed, "page.tsx");
  return existsSync(candidate) ? candidate : null;
}

function importedServices(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']@\/(domain\/[^"']+)["']/g)) {
    for (const name of m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!)) {
      if (/Service$/.test(name)) map.set(name, path.join(SRC, `${m[2]}.ts`));
    }
  }
  return map;
}

/** `Service.method` -> the permission asserted first in that method body. */
function methodPermission(file: string, method: string): Permission | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const at = text.search(new RegExp(`\\basync ${method}\\s*\\(`));
  if (at < 0) return null;
  const rest = text.slice(at);
  const next = rest.slice(10).search(/\n {2}(async )?[a-zA-Z]+\s*\(/);
  const body = next < 0 ? rest : rest.slice(0, next + 10);
  const m = body.match(/assertPermission\(\s*actor,\s*"([a-z_]+:[a-z_]+)"/);
  return (m?.[1] as Permission | undefined) ?? null;
}

export interface PageRequirements {
  gates: Permission[];
  serviceCalls: Array<{ call: string; permission: Permission | null }>;
}

export function pageRequirements(file: string): PageRequirements {
  const source = readFileSync(file, "utf8");
  const gates = [...source.matchAll(/deniedViewUnless\(\s*actor,\s*"([a-z_]+:[a-z_]+)"/g)].map((m) => m[1] as Permission);
  const services = importedServices(source);
  const serviceCalls: PageRequirements["serviceCalls"] = [];
  const seen = new Set<string>();
  for (const m of source.matchAll(/\b([A-Z][A-Za-z]+Service)\.([a-zA-Z]+)\(\s*actor\b/g)) {
    const call = `${m[1]}.${m[2]}`;
    if (seen.has(call)) continue;
    seen.add(call);
    const file2 = services.get(m[1]!);
    // `listActive` is a thin wrapper that calls `list` (which asserts), so its first assertion is not in its own body.
    const permission: Permission | null =
      call === "DimensionService.listActive" ? "dimension:read" : file2 ? methodPermission(file2, m[2]!) : null;
    serviceCalls.push({ call, permission });
  }
  return { gates, serviceCalls };
}
