import type { DimensionWithValues } from "@/domain/dimensions/dimension-service";

/**
 * A plain `<select name="dimension">` for filtering a report by one
 * dimension value — Phase 5 Slice 2's dimensional reporting (master spec
 * §4). Renders nothing when the org has no dimensions configured yet, so
 * every report page can include this unconditionally without an extra
 * length check. Grouped by dimension (`<optgroup>`) since an org may define
 * more than one (Project, Location, …) and the report filters by exactly
 * one dimension *value* at a time.
 */
export function DimensionFilterField({
  dimensions,
  selectedValueId,
}: {
  dimensions: DimensionWithValues[];
  selectedValueId?: string;
}) {
  const withValues = dimensions.filter((d) => d.values.length > 0);
  if (withValues.length === 0) return null;

  return (
    <div className="space-y-1">
      <label htmlFor="dimension" className="text-xs font-medium text-muted-foreground">
        Dimension
      </label>
      <select
        id="dimension"
        name="dimension"
        defaultValue={selectedValueId ?? ""}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
      >
        <option value="">All</option>
        {withValues.map((d) => (
          <optgroup key={d.id} label={d.name}>
            {d.values.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
