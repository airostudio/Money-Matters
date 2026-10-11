import { NextResponse, type NextRequest } from "next/server";
import {
  NotAMemberError,
  NotAuthenticatedError,
  OrganizationNotFoundError,
  requireOrgAndActor,
} from "@/lib/session";
import { OrganizationArchivedError } from "@/domain/organizations/archive-rules";
import { SearchNotAllowedError, SearchService } from "@/domain/search/search-service";

/**
 * Global search endpoint (master spec s.56): `GET /api/search?org=<slug>&q=<text>`.
 *
 * A route handler rather than a server action on purpose: the palette fires one request per (debounced) keystroke
 * and must be able to CANCEL the stale ones; a fetch with an AbortController can, a server action cannot.
 *
 * Protections:
 *  - Human browser sessions only. The session cookie is the only credential read (`requireOrgAndActor`); an
 *    `Authorization: Bearer` API key / OAuth token is never looked at, so it resolves to 401. The service refuses any
 *    non-HUMAN actor again.
 *  - The caller must be a member of the organization; an archived organization, a non-member and an unknown slug all
 *    answer the same 404 (nothing is revealed). Same guards as every page under `[orgSlug]`.
 *  - Read-only (GET) and refused when the browser says the request is cross-site (`Sec-Fetch-Site`) or the `Origin`
 *    header names another host, so a third-party page cannot make the browser run searches as the signed-in person.
 *  - `Cache-Control: no-store`: results are tenant data.
 *  - The query is validated and bounded in the service (query.ts); this handler only forwards it.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", Vary: "Cookie" };

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function isSameOrigin(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== request.nextUrl.host && new URL(origin).host !== request.headers.get("host")) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);

  const slug = request.nextUrl.searchParams.get("org") ?? "";
  const q = request.nextUrl.searchParams.get("q") ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) return json({ error: "not_found" }, 404);

  try {
    const { actor } = await requireOrgAndActor(slug);
    const result = await SearchService.search(actor, slug, q);
    return json(result, 200);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return json({ error: "unauthenticated" }, 401);
    if (
      error instanceof NotAMemberError ||
      error instanceof OrganizationNotFoundError ||
      error instanceof OrganizationArchivedError
    ) {
      return json({ error: "not_found" }, 404);
    }
    if (error instanceof SearchNotAllowedError) return json({ error: "forbidden" }, 403);
    // Do not echo database or internal detail to the browser (a statement timeout lands here too).
    return json({ error: "search_unavailable" }, 503);
  }
}
