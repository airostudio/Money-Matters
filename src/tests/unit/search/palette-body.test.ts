import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PaletteBody,
  listboxIdFor,
  optionIdFor,
  type PaletteBodyProps,
  type PaletteSection,
} from "@/components/shell/palette-body";

const sections: PaletteSection[] = [
  { id: "commands", heading: "Commands", options: [{ id: "a", label: "New invoice", href: "/acme/sales/invoices/new" }] },
  {
    id: "records-invoice",
    heading: "Invoices",
    options: [
      { id: "b", label: "INV-0001", hint: "Acme - Sent - 110.00 AUD", href: "/acme/sales/invoices/1" },
      { id: "c", label: "INV-0002", href: "/acme/sales/invoices/2" },
    ],
  },
];

function render(overrides: Partial<PaletteBodyProps> = {}) {
  const props: PaletteBodyProps = {
    uid: "u1",
    query: "inv",
    onQueryChange: () => undefined,
    onKeyDown: () => undefined,
    sections,
    active: 1,
    onActivate: () => undefined,
    onChoose: () => undefined,
    status: "ready",
    announcement: "3 results",
    isMac: false,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(PaletteBody, props));
}

describe("command palette: accessibility attributes", () => {
  it("the input is a labelled combobox that controls the listbox and points at the highlighted option", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*role="combobox"/);
    expect(html).toContain('aria-label="Search or run a command"');
    expect(html).toContain(`aria-controls="${listboxIdFor("u1")}"`);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain(`aria-activedescendant="${optionIdFor("u1", 1)}"`);
    expect(html).toContain(`id="${listboxIdFor("u1")}"`);
    expect(html).toMatch(/autoComplete="off"/i);
  });

  it("results are a listbox of options inside labelled groups, with exactly the active one selected", () => {
    const html = render();
    expect(html).toMatch(/role="listbox"[^>]*aria-label="Results"|aria-label="Results"[^>]*role="listbox"/);
    expect(html.match(/role="option"/g)).toHaveLength(3);
    expect(html.match(/role="group"/g)).toHaveLength(2);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/aria-selected="false"/g)).toHaveLength(2);
    // every option id is the one aria-activedescendant can name; every group is labelled by its heading
    for (const i of [0, 1, 2]) expect(html).toContain(`id="${optionIdFor("u1", i)}"`);
    expect(html).toContain('aria-labelledby="u1-h-commands"');
    expect(html).toContain('id="u1-h-commands"');
    expect(html).toContain('aria-labelledby="u1-h-records-invoice"');
  });

  it("the active descendant is on the option marked selected", () => {
    const html = render({ active: 2 });
    expect(html).toMatch(new RegExp(`id="${optionIdFor("u1", 2)}"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="${optionIdFor("u1", 2)}"`));
    expect(html).toContain(`aria-activedescendant="${optionIdFor("u1", 2)}"`);
  });

  it("announces the result count politely and atomically to screen readers", () => {
    const html = render({ announcement: "3 results" });
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"|aria-live="polite"[^>]*role="status"/);
    expect(html).toContain(">3 results<");
    expect(render({ announcement: "Searching", status: "loading" })).toContain(">Searching<");
  });

  it("with nothing to show it says so in text (not by an empty box) and drops aria-activedescendant", () => {
    const none = render({ sections: [], query: "zzzz", announcement: "0 results" });
    expect(none).toContain("No matches.");
    expect(none).not.toContain("aria-activedescendant");
    expect(render({ sections: [], query: "a" })).toContain("Keep typing");
    expect(render({ sections: [], query: "" })).toContain("Start typing");
  });

  it("failures are readable text, not colour alone", () => {
    expect(render({ status: "error" })).toContain("Search is unavailable right now");
    expect(render({ status: "signed-out" })).toContain("session has expired");
  });

  it("lists the keyboard shortcuts in a help row", () => {
    const html = render();
    expect(html).toContain('data-testid="palette-help"');
    for (const text of ["move", "open", "Esc", "Ctrl K", "create"]) expect(html).toContain(text);
    expect(render({ isMac: true })).toContain("⌘K");
  });

  it("decorative icons are hidden from assistive technology and the Enter glyph is named", () => {
    const html = render();
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('aria-label="Enter"');
  });
});
