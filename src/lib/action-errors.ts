import "server-only";
import { redirect } from "next/navigation";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";

/**
 * The catch-all every org server action ends with. A stale tab, a bookmarked
 * form or a crafted request from a member whose role cannot do the thing makes
 * the domain service throw `PermissionDeniedError`; rather than letting that
 * surface as an HTTP 500, the action redirects to a friendly page that names
 * the area and the role. Anything else is rethrown untouched.
 *
 * Presentation only: the refusal still happened in the service, nothing was
 * written, and this never swallows the error into a success.
 */
export function rethrowPermissionDenied(error: unknown, orgSlug: string): never {
  if (error instanceof PermissionDeniedError) {
    redirect(`/${orgSlug}/access-denied?permission=${encodeURIComponent(error.permission)}`);
  }
  throw error;
}
