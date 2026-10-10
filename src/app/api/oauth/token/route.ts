import { handleTokenRequest, methodNotAllowedResponse } from "@/domain/oauth/http";

// RFC 6749 token endpoint (docs/api.md "OAuth 2.0"). All the logic is in src/domain/oauth/http.ts; this file only binds it
// to the URL. POST only, form-encoded only, never any CORS header, every response `no-store`.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (request: Request) => handleTokenRequest(request);
export const GET = () => methodNotAllowedResponse();
