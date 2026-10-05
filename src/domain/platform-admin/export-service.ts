import { db } from "@/db/client";
import { DirectoryService, type DirectoryQuery } from "./directory-service";
import { verifyPlatformAdmin } from "./identity";
import { PlatformAuditService } from "./platform-audit-service";

/**
 * CSV cell escaping. Besides RFC 4180 quoting, cells beginning with a
 * spreadsheet formula trigger (= + - @ tab CR) are prefixed with an
 * apostrophe so a hostile user name like `=HYPERLINK(...)` cannot execute
 * when the admin opens the export in Excel/Sheets (CSV injection).
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export type DirectoryExportKind = "users" | "organizations";

/** Directory data only (users / organizations tables) — never tenant financials. Each export is itself audited. */
export const ExportService = {
  async exportDirectory(adminUserId: string, kind: DirectoryExportKind, query: DirectoryQuery = {}): Promise<string> {
    const admin = await verifyPlatformAdmin(adminUserId);

    let csv: string;
    let rowCount: number;
    if (kind === "organizations") {
      const orgs = await DirectoryService.exportOrganizations(adminUserId, query);
      rowCount = orgs.length;
      csv = toCsv(
        ["id", "name", "slug", "plan_tier", "seats_used", "seat_limit", "created_at"],
        orgs.map((o) => [o.id, o.name, o.slug, o.planTier, o.seatsUsed, o.seatLimit, o.createdAt]),
      );
    } else {
      const rows = await DirectoryService.exportUsers(adminUserId, query);
      rowCount = rows.length;
      csv = toCsv(
        ["id", "email", "name", "status", "created_at", "organizations"],
        rows.map((u) => [
          u.id,
          u.email,
          u.name,
          u.disabledAt ? "suspended" : "active",
          u.createdAt,
          u.organizations.map((o) => `${o.name} (${o.role})`).join("; "),
        ]),
      );
    }

    await PlatformAuditService.record(db, admin, {
      action: "directory.exported",
      targetType: "Directory",
      targetId: kind,
      metadata: { rowCount, query: { q: query.q ?? null, seats: query.seats ?? null } },
    });
    return csv;
  },
};
