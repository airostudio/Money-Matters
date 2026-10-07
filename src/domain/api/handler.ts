import { randomUUID } from "node:crypto";
import { assertPermission } from "@/domain/permissions/permission-service";
import { authenticateApiKey, rateLimitHeaders } from "./api-auth";
import { clientAddress } from "./auth-throttle";
import { ApiError, apiErrors, toApiError, toProblem } from "./errors";
import { parseIdempotencyKey } from "./idempotency";
import type { EndpointDef } from "./endpoints";
import type { RateLimitState } from "./rate-limit";
import { scheduleDispatchAfterResponse } from "@/domain/webhooks/post-response";

/**
 * The request pipeline every v1 route runs through. In order, and each step before the next costs anything:
 *
 *   1. request id (a fresh UUID, echoed in `X-Request-Id` and every error body; never taken from the client)
 *   2. authentication: per-IP failure throttle (memory) -> bearer parse + shape check (no DB) -> ONE lookup query
 *      -> hash/revoked/expired/creator checks -> ONE rate-limit statement (429 + Retry-After when exceeded)
 *   3. scope + permission checks (no DB): `insufficient_scope` / `permission_denied` (403)
 *   4. body: JSON-only, size limit, strict zod validation (422 with field errors); query: strict validation (400)
 *   5. Idempotency-Key header (required for invoice/bill creation)
 *   6. the endpoint's work - exactly one `withTenant` transaction as `mm_app`, for the key's organization
 *
 * Never read or written here: cookies (the session is ignored entirely and no cookie is ever set) and CORS (no
 * `Access-Control-*` header is ever sent: this API is server-to-server). Every response is `no-store`.
 */
export const MAX_BODY_BYTES = 256 * 1024;

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function jsonResponse(status: number, body: unknown, headers: Record<string, string>, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": contentType, ...headers },
  });
}

export function problemResponse(error: ApiError, requestId: string, extraHeaders: Record<string, string> = {}): Response {
  return jsonResponse(error.status, toProblem(error, requestId), { "X-Request-Id": requestId, ...(error.extra.headers ?? {}), ...extraHeaders }, "application/problem+json");
}

/** Reads the body but never more than the limit: a chunked or lying request cannot make the server buffer more. */
async function readCappedText(request: Request, limit: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw apiErrors.bodyTooLarge(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

async function readJsonBody(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) throw apiErrors.unsupportedMediaType();
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw apiErrors.bodyTooLarge(MAX_BODY_BYTES);
  const text = await readCappedText(request, MAX_BODY_BYTES);
  if (text.trim() === "") throw apiErrors.bodyRequired();
  try {
    return JSON.parse(text);
  } catch {
    throw apiErrors.invalidJson();
  }
}

function rawQueryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    // A repeated parameter is ambiguous; join so strict validation rejects it rather than guessing.
    out[key] = values.length === 1 ? (values[0] as string) : values.join("\u0000");
  }
  return out;
}

export interface RouteContext {
  params?: Record<string, string>;
}

/** Builds the Next.js route handler for one endpoint. */
export function route(def: EndpointDef) {
  return async function handler(request: Request, context?: RouteContext): Promise<Response> {
    const requestId = randomUUID();
    let rate: RateLimitState | null = null;
    try {
      const url = new URL(request.url);

      let principalResult: Awaited<ReturnType<typeof authenticateApiKey>> | null = null;
      if (!def.public) {
        principalResult = await authenticateApiKey(request.headers.get("authorization"), clientAddress(request.headers));
        rate = principalResult.rate;

        const { principal } = principalResult;
        if (def.scope && !principal.scopes.includes(def.scope)) throw apiErrors.insufficientScope(def.scope);
        for (const permission of def.permissions) assertPermission(principal.actor, permission);
      }

      const rawQuery = rawQueryOf(url);
      const parsedQuery = def.query.safeParse(rawQuery);
      if (!parsedQuery.success) {
        throw apiErrors.invalidQuery(
          parsedQuery.error.issues.map((i) => ({
            field: i.path.join(".") || "(query)",
            message: i.code === "unrecognized_keys" ? `Unknown parameter(s): ${i.keys.join(", ")}.` : i.message,
          })),
        );
      }

      let body: unknown;
      let idempotencyKey: string | null = null;
      if (def.method === "POST") {
        idempotencyKey = parseIdempotencyKey(request.headers.get("idempotency-key"));
        if (def.idempotency === "required" && !idempotencyKey) throw apiErrors.idempotencyKeyRequired();
        const raw = await readJsonBody(request);
        const parsedBody = def.body ? def.body.safeParse(raw) : { success: true as const, data: raw };
        if (!parsedBody.success) throw parsedBody.error;
        body = parsedBody.data;
      }

      // Public endpoints carry no principal; their `run` never reads one.
      const result = await def.run({
        principal: principalResult?.principal as never,
        rate: (principalResult?.rate ?? undefined) as never,
        query: parsedQuery.data,
        body,
        params: context?.params ?? {},
        requestId,
        idempotencyKey,
        requestPath: url.pathname,
        rawQuery,
      });

      // Phase 10 Slice 2: a creation that committed may have written outbox events. Dispatch them AFTER this response, on a
      // fresh connection (this request's transaction has already committed); it can never throw into the request.
      if (principalResult && def.method === "POST" && result.status === 201 && !result.replayed) {
        void scheduleDispatchAfterResponse(principalResult.principal.actor.organizationId);
      }

      const headers: Record<string, string> = { "X-Request-Id": requestId, ...(result.headers ?? {}) };
      if (rate) Object.assign(headers, rateLimitHeaders(rate));
      if (result.replayed) headers["Idempotent-Replayed"] = "true";
      return jsonResponse(result.status, result.body, headers);
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.status >= 500 || apiError.code === "internal_error") {
        // The only place the real failure is visible: server logs, keyed by request id. Never the response.
        const first = (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 300);
        console.error(`[api] ${def.method} ${def.path} request=${requestId} failed: ${first}`);
      }
      return problemResponse(apiError, requestId, rate && !apiError.extra.headers?.["X-RateLimit-Limit"] ? rateLimitHeaders(rate) : {});
    }
  };
}

/** For a method an endpoint does not implement (e.g. POST to a read-only path): a problem+json 405 with `Allow`. */
export function methodNotAllowed(allow: string) {
  return async function handler(): Promise<Response> {
    return problemResponse(apiErrors.methodNotAllowed(allow), randomUUID());
  };
}

/** The catch-all for unknown paths under /api/v1. */
export async function notFoundHandler(): Promise<Response> {
  return problemResponse(apiErrors.routeNotFound(), randomUUID());
}
