import { CornerDownLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Permission } from "@/domain/permissions/roles";
import { MIN_QUERY_LENGTH } from "@/domain/search/query";

/**
 * The inside of the command palette's dialog: the combobox input, the live region and the listbox. Presentational
 * only (no state, no router, no fetch), so its accessibility attributes can be rendered and asserted in a unit test
 * (src/tests/unit/search/palette-body.test.tsx); command-palette.tsx owns the behaviour and Radix owns the dialog.
 *
 * ARIA pattern: WAI-ARIA "combobox with listbox popup". Focus stays in the input; the highlighted row is exposed with
 * `aria-activedescendant`; each row is a `role="option"` inside a labelled `role="group"`; a polite live region
 * announces the result count / state.
 */

export interface PaletteOption {
  id: string;
  label: string;
  hint?: string;
  href: string;
  /** Present when choosing it should be remembered under "Recent". */
  remember?: { permissions: Permission[] };
}

export interface PaletteSection {
  id: string;
  heading: string;
  options: PaletteOption[];
}

export type PaletteStatus = "idle" | "loading" | "ready" | "signed-out" | "error";

export interface PaletteBodyProps {
  /** Unique prefix for generated element ids (React `useId`). */
  uid: string;
  query: string;
  onQueryChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  sections: PaletteSection[];
  active: number;
  onActivate: (index: number) => void;
  onChoose: (option: PaletteOption) => void;
  status: PaletteStatus;
  announcement: string;
  isMac: boolean;
}

export const listboxIdFor = (uid: string) => `${uid}-listbox`;
export const optionIdFor = (uid: string, index: number) => `${uid}-opt-${index}`;

const KBD = "rounded border border-border px-1 font-sans";

export function PaletteBody(props: PaletteBodyProps) {
  const { uid, query, sections, active, status } = props;
  const trimmed = query.trim();
  const count = sections.reduce((n, s) => n + s.options.length, 0);
  let running = -1;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={props.inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxIdFor(uid)}
          aria-autocomplete="list"
          aria-activedescendant={count > 0 ? optionIdFor(uid, Math.min(active, count - 1)) : undefined}
          aria-label="Search or run a command"
          data-testid="palette-input"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={200}
          value={query}
          onChange={(e) => props.onQueryChange(e.target.value)}
          onKeyDown={props.onKeyDown}
          placeholder="Search customers, invoices, bills... or type a command"
          className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="palette-status">
        {props.announcement}
      </div>

      <div id={listboxIdFor(uid)} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1">
        {sections.map((section) => (
          <div key={section.id} role="group" aria-labelledby={`${uid}-h-${section.id}`} className="py-1">
            <div
              id={`${uid}-h-${section.id}`}
              className="px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              {section.heading}
            </div>
            {section.options.map((option) => {
              running += 1;
              const index = running;
              const isActive = index === active;
              return (
                <div
                  key={option.id}
                  id={optionIdFor(uid, index)}
                  role="option"
                  aria-selected={isActive}
                  data-testid="palette-option"
                  onMouseMove={() => props.onActivate(index)}
                  onClick={() => props.onChoose(option)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm",
                    isActive ? "bg-accent text-accent-foreground" : "text-foreground",
                  )}
                >
                  <span className="min-w-0 truncate font-medium">{option.label}</span>
                  {option.hint ? (
                    <span className="min-w-0 max-w-[50%] shrink-0 truncate text-xs text-muted-foreground">{option.hint}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
        {count === 0 && status !== "loading" ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {trimmed === ""
              ? "Start typing to search."
              : Array.from(trimmed).length < MIN_QUERY_LENGTH
                ? `Keep typing: records are searched from ${MIN_QUERY_LENGTH} characters.`
                : "No matches."}
          </p>
        ) : null}
        {status === "loading" ? <p className="px-3 py-2 text-xs text-muted-foreground">Searching records...</p> : null}
        {status === "error" ? (
          <p className="px-3 py-2 text-xs text-destructive">Search is unavailable right now. Commands and pages still work.</p>
        ) : null}
        {status === "signed-out" ? (
          <p className="px-3 py-2 text-xs text-destructive">Your session has expired. Please sign in again to search records.</p>
        ) : null}
      </div>

      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-xs text-muted-foreground"
        data-testid="palette-help"
      >
        <span>
          <kbd className={KBD}>{"↑"}</kbd> <kbd className={KBD}>{"↓"}</kbd> move
        </span>
        <span>
          <kbd className={KBD}>
            <CornerDownLeft className="inline size-3" aria-label="Enter" />
          </kbd>{" "}
          open
        </span>
        <span>
          <kbd className={KBD}>Esc</kbd> close
        </span>
        <span>
          <kbd className={KBD}>{props.isMac ? "⌘K" : "Ctrl K"}</kbd> search
        </span>
        <span>
          <kbd className={KBD}>C</kbd> create
        </span>
      </div>
    </>
  );
}
