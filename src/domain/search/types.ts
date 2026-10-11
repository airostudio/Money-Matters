import type { SearchKind } from "./entities";

/**
 * The wire shape of `GET /api/search`, shared by the route and the palette. Type-only and pure, so the browser bundle
 * can import it without pulling in the database layer.
 */
export interface SearchResultItem {
  id: string;
  kind: SearchKind;
  title: string;
  /** One line of context, e.g. "Acme Pty Ltd - Sent - 1,100.00 AUD". */
  subtitle: string;
  /** Path including the organization slug, e.g. `/acme/sales/invoices/<id>`. */
  href: string;
}

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  items: SearchResultItem[];
}

export interface SearchResponse {
  query: string;
  groups: SearchGroup[];
}
