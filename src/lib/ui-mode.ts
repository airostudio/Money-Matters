import "server-only";
import { cookies } from "next/headers";
import { UI_MODE_COOKIE, parseUiMode, type UiMode } from "@/components/shell/ui-mode";

/** The viewer's presentation mode, from their own cookie (Business unless they chose Accountant). Presentation only. */
export function getUiMode(): UiMode {
  try {
    return parseUiMode(cookies().get(UI_MODE_COOKIE)?.value);
  } catch {
    // Outside a request (scripts, static rendering): the default presentation.
    return "BUSINESS";
  }
}
