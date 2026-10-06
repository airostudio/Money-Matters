import { z } from "zod/v4";
import { API_SCOPES, SCOPE_INFO } from "./scopes";
import { allEndpoints, type EndpointDef } from "./endpoints";
import { DEFAULT_RATE_LIMIT_PER_MINUTE, MAX_RATE_LIMIT_PER_MINUTE, MIN_RATE_LIMIT_PER_MINUTE } from "./rate-limit";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "./cursor";
import { ProblemOut } from "./schemas";

/**
 * The OpenAPI 3.1 document, GENERATED from the endpoint registry and its zod schemas - never hand-edited - so what
 * is documented is what is validated and what is returned. A test compares its paths and methods with both the
 * registry and the route files, and fails on any mismatch. Contains nothing about any organization.
 */
type Json = Record<string, unknown>;

const toSchema = (schema: z.ZodType, io: "input" | "output"): Json =>
  z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "any" }) as Json;

/** Moves a generated schema's `$defs` into the shared components and points its `$ref`s there. */
function hoist(schema: Json, components: Record<string, Json>): Json {
  const { $schema: _s, $defs, ...rest } = schema as { $schema?: string; $defs?: Record<string, Json> } & Json;
  void _s;
  for (const [name, def] of Object.entries($defs ?? {})) {
    const { id: _id, ...body } = def as { id?: string } & Json;
    void _id;
    components[name] = JSON.parse(JSON.stringify(body).replaceAll("#/$defs/", "#/components/schemas/")) as Json;
  }
  return JSON.parse(JSON.stringify(rest).replaceAll("#/$defs/", "#/components/schemas/")) as Json;
}

const PROBLEM_RESPONSES: Record<string, string> = {
  "400": "Malformed request (invalid JSON, invalid query parameter, invalid cursor, missing or invalid Idempotency-Key).",
  "401": "Missing, malformed, unknown, revoked or expired API key, or its creator is no longer active.",
  "403": "The key lacks the scope, or its creator no longer holds the permission.",
  "404": "Not found - including ids that belong to another organization.",
  "409": "Conflict: locked period, concurrent change, or an identical request still in progress.",
  "413": "Request body too large.",
  "415": "Content-Type must be application/json.",
  "422": "Validation failed (field errors) or Idempotency-Key reused with a different request.",
  "429": "Rate limit exceeded. See Retry-After.",
  "500": "Unexpected error. Quote the requestId.",
  "503": "Temporarily unavailable. Retry after the delay in Retry-After.",
};

function operation(def: EndpointDef, components: Record<string, Json>): Json {
  const pathParams = [...def.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  }));

  const querySchema = toSchema(def.query, "input") as { properties?: Record<string, Json>; required?: string[] };
  const queryParams = Object.entries(querySchema.properties ?? {}).map(([name, schema]) => ({
    name,
    in: "query",
    required: (querySchema.required ?? []).includes(name),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    schema: (({ description: _d, ...rest }) => (void _d, rest))(schema),
  }));

  const headerParams: Json[] =
    def.idempotency === "none"
      ? []
      : [
          {
            name: "Idempotency-Key",
            in: "header",
            required: def.idempotency === "required",
            description:
              "1-255 printable ASCII characters, unique per intended creation. Repeating a request with the same key and body returns the original response (`Idempotent-Replayed: true`) without creating anything again; the same key with a different body is 422 `idempotency_key_reuse`. Keys are scoped to the API key and kept for 24 hours.",
            schema: { type: "string", minLength: 1, maxLength: 255 },
          },
        ];

  const responses: Record<string, Json> = {};
  responses[String(def.successStatus)] = {
    description: def.successStatus === 201 ? "Created." : "OK.",
    headers: {
      "X-Request-Id": { schema: { type: "string" }, description: "Quote this when contacting support." },
      ...(def.public ? {} : {
        "X-RateLimit-Limit": { schema: { type: "integer" } },
        "X-RateLimit-Remaining": { schema: { type: "integer" } },
        "X-RateLimit-Reset": { schema: { type: "integer" }, description: "Unix seconds when the window resets." },
      }),
      ...(def.idempotency !== "none" ? { "Idempotent-Replayed": { schema: { type: "string", enum: ["true"] }, description: "Present on a replayed response." } } : {}),
      ...(def.successStatus === 201 ? { Location: { schema: { type: "string" } } } : {}),
    },
    content: {
      "application/json": {
        schema: def.id === "openapi" ? { type: "object" } : hoist(toSchema(def.response, "output"), components),
      },
    },
  };
  const errorCodes = def.public
    ? ["429"]
    : ["400", "401", "403", ...(def.path.includes("{") ? ["404"] : []), ...(def.method === "POST" ? ["409", "413", "415", "422"] : []), "429", "500", "503"];
  for (const code of errorCodes) responses[code] = { $ref: `#/components/responses/Problem${code}` };

  return {
    operationId: def.id,
    tags: [def.tag],
    summary: def.summary,
    description: def.description,
    ...(def.public ? { security: [] } : { security: [{ bearerAuth: def.scope ? [def.scope] : [] }] }),
    parameters: [...pathParams, ...queryParams, ...headerParams],
    ...(def.body
      ? { requestBody: { required: true, content: { "application/json": { schema: hoist(toSchema(def.body, "input"), components) } } } }
      : {}),
    responses,
  };
}

let cached: Json | undefined;

export function buildOpenApiDocument(): Json {
  if (cached) return cached;
  const components: Record<string, Json> = {};
  const paths: Record<string, Record<string, Json>> = {};
  for (const def of allEndpoints()) {
    paths[def.path] ??= {};
    (paths[def.path] as Record<string, Json>)[def.method.toLowerCase()] = operation(def, components);
  }
  components.Problem = hoist(toSchema(ProblemOut, "output"), components);

  const scopes = Object.fromEntries(API_SCOPES.map((s) => [s, SCOPE_INFO[s].description]));
  const problemResponses = Object.fromEntries(
    Object.entries(PROBLEM_RESPONSES).map(([code, description]) => [
      `Problem${code}`,
      {
        description,
        headers: { "X-Request-Id": { schema: { type: "string" } } },
        content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
      },
    ]),
  );

  cached = {
    openapi: "3.1.0",
    info: {
      title: "Money Matters API",
      version: "1.0.0",
      description: [
        "Server-to-server API for approved integrations. **Read** your organization's customers, suppliers, chart of accounts, invoices, bills, payments, journal entries and financial reports, and **create DRAFT** invoices, bills, customers and suppliers. Posting, approving, voiding, paying and deleting stay with people in the app.",
        "",
        "**Authentication.** Create an API key under Settings > API access (Owner or Administrator). Send it as `Authorization: Bearer mm_live_<prefix>_<secret>` - only in that header, never in a URL. The secret is shown once. Browser use (CORS, cookies) is not supported: keep keys on a server. OAuth 2.0 for third-party apps is planned; the auth layer is designed for it.",
        "",
        "**Effective permissions.** A key can do what its scopes allow AND what the person who created it can currently do. If that person is demoted, removed or suspended, the key shrinks or stops working on the next request.",
        "",
        `**Rate limits.** ${DEFAULT_RATE_LIMIT_PER_MINUTE} requests per minute per key by default (configurable per key between ${MIN_RATE_LIMIT_PER_MINUTE} and ${MAX_RATE_LIMIT_PER_MINUTE}). Every response carries \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\` and \`X-RateLimit-Reset\`; 429 adds \`Retry-After\`.`,
        "",
        `**Pagination.** List endpoints take \`limit\` (1-${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE}) and \`cursor\`, and return \`{ "data": [...], "next_cursor": string | null }\`, newest created first. Cursors are opaque and tied to the query that produced them.`,
        "",
        "**Money and dates.** Money is `{ \"amount\": \"150.00\", \"currency\": \"AUD\" }` with the amount as a decimal string - never a number. Dates are `YYYY-MM-DD`; timestamps are RFC 3339 UTC.",
        "",
        "**Errors.** RFC 7807 `application/problem+json` with a stable `code`, a `requestId` and, for validation failures, per-field `errors`.",
        "",
        "**Methods.** GET, HEAD and POST only. There is no PUT, PATCH or DELETE in v1.",
      ].join("\n"),
    },
    servers: [{ url: "/api/v1" }],
    tags: [...new Set(allEndpoints().map((e) => e.tag))].map((name) => ({ name })),
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "mm_live_<prefix>_<secret>",
          description: `API key. Scopes: ${Object.entries(scopes).map(([k, v]) => `\`${k}\` - ${v}`).join(" ")}`,
        },
      },
      schemas: components,
      responses: problemResponses,
    },
  };
  return cached;
}

/** [method, path] pairs the document describes - what the parity test compares with the routes. */
export function documentedOperations(): string[] {
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
  return Object.entries(doc.paths)
    .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`))
    .sort();
}
