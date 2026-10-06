import { notFoundHandler } from "@/domain/api/handler";

// Anything under /api/v1 that is not a real endpoint: a JSON problem, never an HTML 404 page.
// (PUT/PATCH/DELETE/OPTIONS on any v1 path are answered with 405 by src/middleware.ts before reaching a route.)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = notFoundHandler;
export const POST = notFoundHandler;
