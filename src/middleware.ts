import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/register"];

/** The public developer API (docs/api.md). Authenticated by API key inside the route, never by the browser session. */
const API_PREFIX = "/api/v1";
const API_METHODS = new Set(["GET", "HEAD", "POST"]);

function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/**
 * `/api/v1/*`: NextAuth is bypassed entirely - no redirect to /login, no session lookup - because the API
 * authenticates itself with `Authorization: Bearer <api key>` (src/domain/api/api-auth.ts). Two structural
 * guarantees are enforced HERE, before any route code runs:
 *  - the browser's cookies are removed from the request the route sees, so no session cookie can ever act on the
 *    API (cookie-borne CSRF has nothing to ride on) - the route handlers never read cookies and set none;
 *  - only GET, HEAD and POST exist in v1: PUT / PATCH / DELETE / OPTIONS get a 405 problem response. OPTIONS in
 *    particular means no CORS preflight is ever answered and no `Access-Control-*` header is ever sent - the API
 *    is for servers, not browsers.
 */
function handleApi(request: NextRequest): NextResponse {
  if (!API_METHODS.has(request.method)) {
    const requestId = crypto.randomUUID();
    return new NextResponse(
      JSON.stringify({
        type: "urn:moneymatters:problem:method_not_allowed",
        title: "Method not allowed",
        status: 405,
        code: "method_not_allowed",
        detail: "The v1 API supports GET, HEAD and POST only. There is no PUT, PATCH or DELETE.",
        requestId,
      }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/problem+json",
          Allow: "GET, HEAD, POST",
          "Cache-Control": "no-store",
          "X-Request-Id": requestId,
        },
      },
    );
  }
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return NextResponse.next({ request: { headers } });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isApiPath(pathname)) {
    return handleApi(request);
  }

  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path)) || pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // The platform admin section must 404 for signed-out visitors too (not
  // redirect to /login), so its existence isn't revealed. Authorisation is
  // NOT done here — every admin page, route handler and server action calls
  // requirePlatformAdmin() itself (src/lib/platform-admin.ts).
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return NextResponse.next();
  }

  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
