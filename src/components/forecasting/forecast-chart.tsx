import type { ForecastSeriesPoint } from "@/domain/forecasting/types";

/**
 * The two-series cash chart (master spec §38): KNOWN-commitments-only as a
 * solid line, INCLUDING-statistical as a dashed line in a second colour —
 * differentiated by BOTH stroke style and colour so it reads without relying
 * on colour alone — with the low-cash threshold and the zero line drawn as
 * reference lines. Pure server-rendered SVG (no chart dependency, no client
 * JS). Coordinates use plain Number: this is display geometry only, never a
 * calculation that feeds back into a money value.
 */
const W = 760;
const H = 260;
const PAD = { top: 16, right: 16, bottom: 28, left: 72 };

function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return n.toFixed(0);
}

export function ForecastChart({
  known,
  statistical,
  threshold,
  currency,
}: {
  known: ForecastSeriesPoint[];
  statistical: ForecastSeriesPoint[];
  threshold: string;
  currency: string;
}) {
  const k = known.map((p) => Number(p.balance));
  const s = statistical.map((p) => Number(p.balance));
  const t = Number(threshold);
  const all = [...k, ...s, 0, t];
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.06;
  min -= pad;
  max += pad;

  const n = Math.max(known.length, 2);
  const x = (i: number) => PAD.left + (i / (n - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom);
  const path = (values: number[]) => values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const ticks = [min + pad, (min + max) / 2, max - pad];
  const first = known[0]?.date ?? "";
  const last = known[known.length - 1]?.date ?? "";

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Projected cash balance in ${currency} from ${first} to ${last}: a solid line for known commitments only and a dashed line including statistical projections.`}
        className="h-auto w-full"
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {compact(v)}
            </text>
          </g>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} className="stroke-muted-foreground" strokeWidth={1} />
        {t !== 0 && (
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="stroke-destructive" strokeWidth={1} strokeDasharray="2 3" />
        )}
        <path d={path(s)} fill="none" className="stroke-warning" strokeWidth={2} strokeDasharray="6 4" />
        <path d={path(k)} fill="none" className="stroke-primary" strokeWidth={2.5} />
        <text x={PAD.left} y={H - 8} className="fill-muted-foreground text-[11px]">
          {first}
        </text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" className="fill-muted-foreground text-[11px]">
          {last}
        </text>
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <svg width="28" height="8" aria-hidden="true">
            <line x1="0" x2="28" y1="4" y2="4" className="stroke-primary" strokeWidth={2.5} />
          </svg>
          Known commitments only
        </span>
        <span className="inline-flex items-center gap-2">
          <svg width="28" height="8" aria-hidden="true">
            <line x1="0" x2="28" y1="4" y2="4" className="stroke-warning" strokeWidth={2} strokeDasharray="6 4" />
          </svg>
          Including statistical projections
        </span>
        {t !== 0 && (
          <span className="inline-flex items-center gap-2">
            <svg width="28" height="8" aria-hidden="true">
              <line x1="0" x2="28" y1="4" y2="4" className="stroke-destructive" strokeWidth={1} strokeDasharray="2 3" />
            </svg>
            Low-cash threshold
          </span>
        )}
      </figcaption>
    </figure>
  );
}
