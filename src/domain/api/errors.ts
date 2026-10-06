import { ZodError } from "zod/v4";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import { PeriodLockedError } from "@/domain/ledger/errors";
import {
  InvalidContactForInvoiceError,
  InvalidInvoiceLineError,
  TaxCodeMissingPayableAccountError,
} from "@/domain/sales/errors";
import {
  InvalidBillLineError,
  InvalidContactForBillError,
  TaxCodeMissingReceivableAccountError,
} from "@/domain/purchases/errors";
import { ProductCurrencyMismatchError } from "@/domain/inventory/errors";
import { InvalidScopeError } from "./scopes";

/**
 * The API's predictable error model: RFC 7807 problem details served as `application/problem+json`.
 *
 *   { "type": "urn:moneymatters:problem:<code>", "title": "...", "status": 422, "code": "<code>",
 *     "detail": "...", "requestId": "<uuid>", "errors": [{ "field": "lines[0].quantity", "message": "..." }] }
 *
 * `code` is the stable, machine-readable discriminator (clients switch on it, never on `detail`). The mapping from
 * domain failures to HTTP is in `toApiError` below and is a single table, unit-tested. What never leaves the
 * server: stack traces, SQL, driver messages, internal ids of other tenants. An unexpected error is a generic 500
 * carrying only the request id (the real error is logged server-side against that id).
 */
export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail: string,
    readonly extra: { errors?: FieldError[]; headers?: Record<string, string>; [key: string]: unknown } = {},
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  requestId: string;
  errors?: FieldError[];
  [key: string]: unknown;
}

export const problemType = (code: string) => `urn:moneymatters:problem:${code}`;

export function toProblem(error: ApiError, requestId: string): Problem {
  const { errors, headers: _headers, ...rest } = error.extra;
  void _headers;
  return {
    type: problemType(error.code),
    title: error.title,
    status: error.status,
    code: error.code,
    detail: error.detail,
    requestId,
    ...(errors && errors.length > 0 ? { errors } : {}),
    ...rest,
  };
}

// ---- Constructors for the errors the API raises itself -------------------------------------------------------

export const apiErrors = {
  invalidApiKey: () =>
    new ApiError(401, "invalid_api_key", "Authentication failed", "The API key is missing, malformed or not recognised. Send it as `Authorization: Bearer <key>`."),
  apiKeyRevoked: () => new ApiError(401, "api_key_revoked", "API key revoked", "This API key has been revoked."),
  apiKeyExpired: () => new ApiError(401, "api_key_expired", "API key expired", "This API key has expired."),
  apiKeyOwnerInactive: () =>
    new ApiError(
      401,
      "api_key_owner_inactive",
      "API key owner is no longer active",
      "The person who created this key has been removed from the organization or suspended, so the key no longer works.",
    ),
  tooManyFailures: (retryAfter: number) =>
    new ApiError(429, "too_many_failed_attempts", "Too many failed attempts", "Too many requests with an invalid API key from this address. Try again shortly.", {
      headers: { "Retry-After": String(retryAfter) },
    }),
  insufficientScope: (required: string) =>
    new ApiError(403, "insufficient_scope", "Insufficient scope", `This API key does not have the "${required}" scope.`, { requiredScope: required }),
  permissionDenied: (permission: string) =>
    new ApiError(
      403,
      "permission_denied",
      "Permission denied",
      `The user who created this key no longer has permission to do this (${permission}), so the key cannot either.`,
      { permission },
    ),
  notFound: (what = "resource") => new ApiError(404, "not_found", "Not found", `The requested ${what} was not found.`),
  routeNotFound: () => new ApiError(404, "route_not_found", "Not found", "No such API endpoint."),
  methodNotAllowed: (allow: string) =>
    new ApiError(405, "method_not_allowed", "Method not allowed", `This endpoint supports ${allow} only. The v1 API has no PUT, PATCH or DELETE.`, {
      headers: { Allow: allow },
    }),
  invalidJson: () => new ApiError(400, "invalid_json", "Invalid JSON", "The request body is not valid JSON."),
  unsupportedMediaType: () =>
    new ApiError(415, "unsupported_media_type", "Unsupported media type", "Send the body as JSON with `Content-Type: application/json`."),
  bodyTooLarge: (limit: number) =>
    new ApiError(413, "body_too_large", "Request body too large", `The request body must not exceed ${limit} bytes.`),
  bodyRequired: () => new ApiError(400, "body_required", "Request body required", "This endpoint requires a JSON request body."),
  invalidCursor: () => new ApiError(400, "invalid_cursor", "Invalid cursor", "The cursor is malformed, was tampered with, or belongs to a different query."),
  invalidQuery: (errors: FieldError[]) =>
    new ApiError(400, "invalid_query", "Invalid query parameters", "One or more query parameters are invalid.", { errors }),
  validationFailed: (errors: FieldError[]) =>
    new ApiError(422, "validation_failed", "Validation failed", "The request body failed validation.", { errors }),
  idempotencyKeyRequired: () =>
    new ApiError(400, "idempotency_key_required", "Idempotency-Key required", "This endpoint requires an `Idempotency-Key` header (1-255 printable ASCII characters) so a retry can never create a duplicate."),
  idempotencyKeyInvalid: () =>
    new ApiError(400, "idempotency_key_invalid", "Invalid Idempotency-Key", "The `Idempotency-Key` header must be 1-255 printable ASCII characters."),
  idempotencyKeyReuse: () =>
    new ApiError(422, "idempotency_key_reuse", "Idempotency-Key reused", "This Idempotency-Key was already used with a different request. Use a new key for a new request."),
  idempotencyInProgress: () =>
    new ApiError(409, "idempotency_in_progress", "Request already in progress", "A request with this Idempotency-Key is still being processed. Retry shortly.", {
      headers: { "Retry-After": "2" },
    }),
  conflict: () =>
    new ApiError(409, "conflict", "Conflict", "The request conflicted with a concurrent change. Retry it (with the same Idempotency-Key).", {
      headers: { "Retry-After": "1" },
    }),
  unavailable: () =>
    new ApiError(503, "service_unavailable", "Service temporarily unavailable", "The service is temporarily unable to process requests. Retry shortly.", {
      headers: { "Retry-After": "5" },
    }),
  internal: () =>
    new ApiError(500, "internal_error", "Internal error", "Something went wrong on our side. Quote the request id if you contact support."),
};

function pathOf(path: PropertyKey[]): string {
  return path.map((part, index) => (typeof part === "number" ? `[${part}]` : index === 0 ? String(part) : `.${String(part)}`)).join("");
}

function zodFieldErrors(error: ZodError): FieldError[] {
  return error.issues.flatMap((issue): FieldError[] => {
    const base = pathOf(issue.path);
    // One entry per unknown key, named, so a typo or a forbidden field (e.g. `total`) is pinpointed.
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ field: base ? `${base}.${key}` : key, message: "Unknown field: not accepted by this endpoint." }));
    }
    return [{ field: base === "" ? "(body)" : base, message: issue.message }];
  });
}

interface PgLikeError {
  code?: string;
  constraint?: string;
  cause?: PgLikeError;
}

function pgCause(error: unknown): PgLikeError | null {
  let current = error as PgLikeError | undefined;
  for (let i = 0; i < 4 && current; i += 1) {
    if (typeof current.code === "string") return current;
    current = current.cause;
  }
  return null;
}

/** Is this a database "cannot get a connection right now" failure (pool/pooler exhaustion, paused project)? */
function isConnectionFailure(error: unknown): boolean {
  const cause = pgCause(error);
  if (cause?.code && ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EMAXCONNSESSION", "53300", "57P03", "08006", "08001"].includes(cause.code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /timeout exceeded when trying to connect|EMAXCONNSESSION|max clients reached|Connection terminated/i.test(message);
}

/**
 * THE mapping table from anything thrown to the API's error. Not-found and cross-tenant are both 404, never 403, so
 * the API cannot be used to learn whether an id exists in someone else's organization.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) return apiErrors.validationFailed(zodFieldErrors(error));
  if (error instanceof PermissionDeniedError) return apiErrors.permissionDenied(error.permission);
  if (error instanceof InvalidScopeError) return apiErrors.validationFailed([{ field: "scopes", message: error.message }]);
  if (error instanceof PeriodLockedError) {
    return new ApiError(
      409,
      "period_locked",
      "Period locked",
      `The fiscal period "${error.periodLabel}" is locked, so the API cannot create documents dated in it. Use a date in an open period, or ask a person to reopen it in Money Matters.`,
      { lockLevel: error.lockLevel, period: error.periodLabel },
    );
  }
  if (error instanceof InvalidContactForInvoiceError) {
    return apiErrors.validationFailed([{ field: "customer_id", message: "Not an active customer in this organization." }]);
  }
  if (error instanceof InvalidContactForBillError) {
    return apiErrors.validationFailed([{ field: "supplier_id", message: "Not an active supplier in this organization." }]);
  }
  if (error instanceof InvalidInvoiceLineError || error instanceof InvalidBillLineError) {
    return apiErrors.validationFailed([{ field: "lines", message: error.message }]);
  }
  if (error instanceof ProductCurrencyMismatchError) return apiErrors.validationFailed([{ field: "currency", message: error.message }]);
  if (error instanceof TaxCodeMissingPayableAccountError || error instanceof TaxCodeMissingReceivableAccountError) {
    return apiErrors.validationFailed([{ field: "lines", message: error.message }]);
  }
  const pg = pgCause(error);
  if (pg?.code === "23505") return apiErrors.conflict(); // unique violation: a concurrent create took the same document number
  if (pg?.code === "40001" || pg?.code === "40P01") return apiErrors.conflict(); // serialization failure / deadlock
  if (isConnectionFailure(error)) return apiErrors.unavailable();
  return apiErrors.internal();
}
