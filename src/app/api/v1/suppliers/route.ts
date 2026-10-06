import { endpoint } from "@/domain/api/endpoints";
import { methodNotAllowed, route } from "@/domain/api/handler";

// Public developer API v1 (docs/api.md). The work is defined once in the endpoint registry
// (src/domain/api/endpoints.ts); this file only binds it to the URL.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(endpoint("suppliers.list"));
export const POST = route(endpoint("suppliers.create"));
