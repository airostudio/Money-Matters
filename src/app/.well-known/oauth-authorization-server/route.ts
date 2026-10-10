import { buildMetadata, issuerFor } from "@/domain/oauth/metadata";

// RFC 8414 authorization server metadata. Public, read-only, identical for every caller. The ONLY response in the OAuth
// surface that sends a CORS header (a browser-based tool may discover the endpoints); the token and revocation endpoints
// never do. Fully static per deployment, so it is cacheable.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Response {
  return new Response(JSON.stringify(buildMetadata(issuerFor(request.url))), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
