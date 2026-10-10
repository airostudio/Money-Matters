import { handleRevocationRequest, methodNotAllowedResponse } from "@/domain/oauth/http";

// RFC 7009 token revocation endpoint. Same shell as the token endpoint (src/domain/oauth/http.ts).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (request: Request) => handleRevocationRequest(request);
export const GET = () => methodNotAllowedResponse();
