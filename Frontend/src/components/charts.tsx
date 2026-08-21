import { cn } from '@/lib/utils';

/**
 * The two chart shapes the blueprint draws, built from CSS and inline SVG.
 *
 * The prototype loads Chart.js from a CDN for these. That is a ~200KB runtime plus a
 * third-party request, and it would have to become a client component, for two figures that do
 * not animate, zoom or hit-test. A flex row of bars and one stroked circle produce the same
 * picture, render on the server, and cost nothing.
 *
 * Both are `role="img"` with a summary label, and both print their values as text beside the
 * drawing. A chart whose only representation is the drawing is unreadable to a screen reader
 * and to anyone who cannot separate the colours.
 */

export interface Slice {
  label: string;
  /** Raw magnitude. Percentages are derived here so callers never have to pre-normalise. */
  value: number;
  /** A palette token name - `success`, `brand`, `warning`, `danger`, `neutral`. */
  tone: keyof typeof SLICE_TONE;
}

const SLICE_TONE = {
  brand: { fill: 'var(--brand-vivid)', dot: 'bg-brand-vivid' },
  success: { fill: 'var(--success-vivid)', dot: 'bg-success-vivid' },
  warning: { fill: 'var(--warning)', dot: 'bg-warning' },
  danger: { fill: 'var(--danger)', dot: 'bg-danger' },
  neutral: { fill: 'var(--neutral-dot)', dot: 'bg-neutral-dot' },
} as const;

/**
 * Doughnut. Drawn as a single circle whose dash pattern is walked round the circumference, so
 * there is one path per slice and no arc maths.
 */
export function DonutChart({
  slices,
  caption,
  className,
}: {
  slices: Slice[];
  /** Describes the whole figure for a screen reader. */
  caption: string;
  className?: string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  // 2 * PI * 42, the radius below. Kept as a constant so the dash maths reads in one line.
  const CIRCUMFERENCE = 263.89;

  let offset = 0;

  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-6', className)}>
      <svg viewBox="0 0 100 100" className="size-[150px] shrink-0 -rotate-90" role="img" aria-label={caption}>
        {total <= 0 ? (
          <circle cx="50" cy="50" r="42" fill="none" stroke="var(--surface-muted)" strokeWidth="16" />
        ) : (
          slices
            .filter((slice) => slice.value > 0)
            .map((slice) => {
              const length = (slice.value / total) * CIRCUMFERENCE;
              const dash = `${length} ${CIRCUMFERENCE - length}`;
              const element = (
                <circle
                  key={slice.label}
                  cx="50"
                  cy="50"
                  r="42"
                  fill="none"
                  stroke={SLICE_TONE[slice.tone].fill}
                  strokeWidth="16"
                  strokeDasharray={dash}
                  strokeDashoffset={-offset}
                />
              );
              offset += length;
              return element;
            })
        )}
      </svg>

      <dl className="flex flex-col gap-2.5">
        {slices.map((slice) => (
          <div key={slice.label} className="flex items-center gap-2 text-[12.5px]">
            <span className={cn('size-[9px] shrink-0 rounded-full', SLICE_TONE[slice.tone].dot)} aria-hidden />
            <dt className="text-text-secondary">{slice.label}</dt>
            <dd className="tnum ml-auto pl-3 font-medium text-text-primary">
              {total > 0 ? `${Math.round((slice.value / total) * 100)}%` : '-'}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Vertical bars. Heights are a percentage of the largest value, so the tallest bar always fills
 * the plot and the shape stays readable whatever the units are.
 */
export function BarChart({
  bars,
  caption,
  unit = '',
  className,
}: {
  bars: { label: string; value: number }[];
  caption: string;
  /** Appended to the value in each bar's tooltip and its accessible name. */
  unit?: string;
  className?: string;
}) {
  const max = Math.max(...bars.map((bar) => bar.value), 0);

  return (
    <div className={cn('flex h-[220px] flex-col', className)} role="img" aria-label={caption}>
      <div className="flex min-h-0 flex-1 items-end gap-2">
        {bars.map((bar) => (
          <div key={bar.label} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1.5">
            <span className="tnum text-center text-[10.5px] text-text-tertiary">
              {bar.value > 0 ? bar.value : ''}
            </span>
            <div
              className="w-full rounded-t-sm bg-brand-vivid/70 transition-[height]"
              // A floor of 2px so an empty day still reads as a day with nothing in it, rather
              // than vanishing and leaving the axis looking mislabelled.
              style={{ height: max > 0 ? `${Math.max((bar.value / max) * 100, 1.5)}%` : '2px' }}
              title={`${bar.label}: ${bar.value}${unit}`}
            />
          </div>
        ))}
      </div>

      <div className="mt-2 flex gap-2 border-t border-border pt-2">
        {bars.map((bar) => (
          <span key={bar.label} className="min-w-0 flex-1 truncate text-center text-[11px] text-text-tertiary">
            {bar.label}
          </span>
        ))}
      </div>
    </div>
  );
}
