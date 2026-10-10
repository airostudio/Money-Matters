import { allEndpoints } from "@/domain/api/endpoints";
import { route } from "@/domain/api/handler";
import { ApiKeyService } from "@/domain/api/api-key-service";
import { authThrottle } from "@/domain/api/auth-throttle";
import type { Actor } from "@/domain/permissions/permission-service";

/** Creates a key as `owner` (a human OWNER/ADMINISTRATOR) and returns the one-time secret. */
export async function makeKey(
  owner: Actor,
  scopes: string[],
  opts: { name?: string; expiresAt?: Date | null; rateLimitPerMinute?: number | null } = {},
) {
  const created = await ApiKeyService.create(owner, {
    name: opts.name ?? "Test integration",
    scopes,
    expiresAt: opts.expiresAt ?? null,
    rateLimitPerMinute: opts.rateLimitPerMinute ?? null,
  });
  return { id: created.key.id, prefix: created.key.prefix, secret: created.secret };
}

function matchPath(template: string, path: string): Record<string, string> | null {
  const t = template.split("/");
  const p = path.split("/");
  if (t.length !== p.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i += 1) {
    const seg = t[i] as string;
    if (seg.startsWith("{")) params[seg.slice(1, -1)] = decodeURIComponent(p[i] as string);
    else if (seg !== p[i]) return null;
  }
  return params;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: any;
  text: string;
}

export interface CallOptions {
  key?: string | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  ip?: string;
}

/**
 * Calls the REAL route handler pipeline in-process with a real `Request` (no HTTP server): same auth, rate limit,
 * validation, services and database as production. `path` is relative to /api/v1 and may carry a query string.
 */
export async function call(method: "GET" | "POST", path: string, opts: CallOptions = {}): Promise<ApiResponse> {
  const [pathname = "", search = ""] = path.split("?");
  const def = allEndpoints().find((e) => e.method === method && matchPath(e.path, pathname));
  if (!def) throw new Error(`No endpoint for ${method} ${pathname}`);
  const params = matchPath(def.path, pathname) as Record<string, string>;

  const headers = new Headers(opts.headers);
  if (opts.key !== null && opts.key !== undefined) headers.set("authorization", `Bearer ${opts.key}`);
  if (opts.idempotencyKey) headers.set("idempotency-key", opts.idempotencyKey);
  headers.set("x-forwarded-for", opts.ip ?? "203.0.113.7");
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  const request = new Request(`http://localhost/api/v1${pathname}${search ? `?${search}` : ""}`, { method, headers, body });
  const response = await route(def)(request, { params });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

export const get = (path: string, key: string | null, extra: CallOptions = {}) => call("GET", path, { ...extra, key });
export const post = (path: string, key: string | null, body: unknown, extra: CallOptions = {}) => call("POST", path, { ...extra, key, body });

export function resetApiThrottle() {
  authThrottle.clear();
}

export const decimalRegex = /^-?\d+\.\d{2,8}$/;
