"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { UI_MODE_COOKIE, parseUiMode } from "@/components/shell/ui-mode";

/**
 * Switches the Business / Accountant presentation (master spec s.72). It stores the choice in the
 * person's own cookie and nothing else: there is no database write and no permission is involved —
 * the mode changes labels and which entry points the navigation shows, never what a role may do.
 * Only a signed-in user may set it, and only to one of the two known values.
 */
export async function setUiModeAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const mode = parseUiMode(String(formData.get("mode") ?? ""));
  cookies().set(UI_MODE_COOKIE, mode, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });

  // Back to the page the toggle was on: an explicit same-origin path, else the Referer's path.
  const explicit = String(formData.get("returnTo") ?? "");
  let back = "/app";
  if (explicit.startsWith("/") && !explicit.startsWith("//")) {
    back = explicit;
  } else {
    const referer = headers().get("referer");
    const host = headers().get("host");
    if (referer) {
      try {
        const url = new URL(referer);
        if (url.host === host) back = `${url.pathname}${url.search}`;
      } catch {
        // an unparseable Referer just means "go to the landing page"
      }
    }
  }
  redirect(back);
}
