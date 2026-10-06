import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { allEndpoints, endpoint } from "@/domain/api/endpoints";
import { buildOpenApiDocument, documentedOperations } from "@/domain/api/openapi";
import { API_SCOPES } from "@/domain/api/scopes";

const ROUTES_DIR = path.resolve(__dirname, "../../../app/api/v1");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? routeFiles(full) : name === "route.ts" ? [full] : [];
  });
}

/** `[METHOD path]` pairs the route FILES bind to endpoints, read from the source (no module loading needed). */
function boundRoutes(): { operation: string; endpointId: string; filePath: string }[] {
  const out: { operation: string; endpointId: string; filePath: string }[] = [];
  for (const file of routeFiles(ROUTES_DIR)) {
    const rel = path.relative(ROUTES_DIR, path.dirname(file)).split(path.sep).join("/");
    if (rel.startsWith("[...")) continue; // the catch-all 404 is not an endpoint
    const urlPath = "/" + rel.replace(/\[(\w+)\]/g, "{$1}");
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/export const (GET|POST) = route\(endpoint\("([^"]+)"\)\);/g)) {
      out.push({ operation: `${m[1]} ${urlPath}`, endpointId: m[2] as string, filePath: file });
    }
  }
  return out;
}

describe("OpenAPI document, endpoint registry and route files cannot drift apart", () => {
  const routes = boundRoutes().map((r) => r.operation).sort();
  const registry = allEndpoints().map((e) => `${e.method} ${e.path}`).sort();
  const documented = documentedOperations();

  it("every route file binds the endpoint registered for exactly its URL and method", () => {
    for (const r of boundRoutes()) {
      const def = endpoint(r.endpointId);
      expect(`${def.method} ${def.path}`, `${r.filePath} binds ${r.endpointId}`).toBe(r.operation);
    }
  });

  it("an implemented route missing from the OpenAPI document (or vice versa) fails this test", () => {
    expect(routes).toEqual(documented);
    expect(registry).toEqual(documented);
  });

  it("v1 has no PUT, PATCH or DELETE anywhere: only GET and POST are documented and bound", () => {
    for (const op of documented) expect(op).toMatch(/^(GET|POST) \//);
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
    for (const methods of Object.values(doc.paths)) {
      for (const m of Object.keys(methods)) expect(["get", "post"]).toContain(m);
    }
    const source = routeFiles(ROUTES_DIR).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(source).not.toMatch(/export const (PUT|PATCH|DELETE|OPTIONS)\b/);
  });

  it("documents authentication, every scope, pagination, idempotency, error and rate-limit behaviour", () => {
    const doc = buildOpenApiDocument() as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    const description = doc.info.description as string;
    for (const topic of ["Authentication", "Effective permissions", "Rate limits", "Pagination", "Money and dates", "Errors", "Methods"]) {
      expect(description, topic).toContain(topic);
    }
    for (const scope of API_SCOPES) expect(doc.components.securitySchemes.bearerAuth.description, scope).toContain(scope);
    expect(Object.keys(doc.components.responses)).toEqual(expect.arrayContaining(["Problem401", "Problem403", "Problem404", "Problem409", "Problem422", "Problem429"]));
    expect(doc.components.schemas.Problem).toBeDefined();
    expect(doc.components.schemas.Money).toBeDefined();

    const createInvoice = doc.paths["/invoices"].post;
    expect(createInvoice.parameters.find((p: any) => p.name === "Idempotency-Key").required).toBe(true);
    expect(createInvoice.security).toEqual([{ bearerAuth: ["invoices:write"] }]);
    expect(createInvoice.responses["201"].headers.Location).toBeDefined();
    expect(createInvoice.responses["422"]).toBeDefined();
    expect(doc.paths["/customers"].post.parameters.find((p: any) => p.name === "Idempotency-Key").required).toBe(false);
    const list = doc.paths["/invoices"].get;
    expect(list.parameters.map((p: any) => p.name)).toEqual(expect.arrayContaining(["limit", "cursor", "status", "customer_id"]));
    expect(doc.paths["/openapi.json"].get.security).toEqual([]);
  });

  it("has no dangling $ref and contains nothing that identifies an organization", () => {
    const text = JSON.stringify(buildOpenApiDocument());
    const schemas = (buildOpenApiDocument() as any).components.schemas as Record<string, unknown>;
    for (const m of text.matchAll(/#\/components\/schemas\/(\w+)/g)) expect(schemas[m[1] as string], m[1]).toBeDefined();
    for (const m of text.matchAll(/#\/components\/responses\/(\w+)/g)) expect((buildOpenApiDocument() as any).components.responses[m[1] as string], m[1]).toBeDefined();
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/); // no concrete ids
    expect(text).not.toMatch(/mm_live_[a-z0-9]{8}_[A-Za-z0-9_-]{43}/);
  });

  it("money fields in every documented response are strings with a currency, never numbers", () => {
    const doc = buildOpenApiDocument() as any;
    const money = doc.components.schemas.Money;
    expect(money.properties.amount.type).toBe("string");
    expect(money.properties.currency).toBeDefined();
    const invoice = doc.components.schemas.Invoice;
    for (const field of ["subtotal", "tax_total", "total", "amount_paid", "amount_due"]) {
      expect(invoice.properties[field].$ref, field).toBe("#/components/schemas/Money");
    }
    const createBody = doc.paths["/invoices"].post.requestBody.content["application/json"].schema;
    expect(createBody.additionalProperties).toBe(false);
    expect(Object.keys(createBody.properties)).not.toEqual(expect.arrayContaining(["total", "subtotal", "tax_total", "status", "number"]));
    expect(createBody.properties.lines.items.properties.unit_price.type).toBe("string");
    expect(createBody.properties.lines.items.properties.quantity.type).toBe("string");
  });
});
