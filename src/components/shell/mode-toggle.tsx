import { setUiModeAction } from "@/app/ui-mode-actions";
import { cn } from "@/lib/utils";
import type { UiMode } from "./ui-mode";

/**
 * Business | Accountant presentation toggle (master spec s.72). Same engine and the same data in
 * both — only terminology and the Practice entry points change. A plain server-action form per
 * option: no client JavaScript, works with the page's own cookie.
 */
export function ModeToggle({ mode, returnTo }: { mode: UiMode; returnTo?: string }) {
  return (
    <div
      role="group"
      aria-label="View mode"
      title="Business uses plain-language terms; Accountant uses accounting terms and shows the Practice section. Same data either way."
      className="inline-flex overflow-hidden rounded-md border border-border text-xs"
    >
      {(["BUSINESS", "ACCOUNTANT"] as const).map((m) => (
        <form key={m} action={setUiModeAction}>
          <input type="hidden" name="mode" value={m} />
          {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
          <button
            type="submit"
            aria-pressed={mode === m}
            className={cn(
              "px-2.5 py-1.5 transition-colors",
              mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
            )}
          >
            {m === "BUSINESS" ? "Business" : "Accountant"}
          </button>
        </form>
      ))}
    </div>
  );
}
