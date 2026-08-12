import type { ReactNode } from 'react';
import type { ProductivityTag, AlertSeverity } from '@/types/api';

/**
 * The dashboard's whole component vocabulary. Deliberately small and hand-rolled rather than
 * pulled from a component library: the brief asked for a minimal UI, and every element here
 * resolves its colours from the CSS variables in globals.css so light and dark stay in step
 * without a second set of class names.
 */

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-border bg-surface ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
          {title && (
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">{title}</h2>
          )}
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/** A single headline number. The overview is built from a row of these. */
export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'brand' | 'warning' | 'danger';
}) {
  const toneClass = {
    default: 'text-text-primary',
    brand: 'text-brand',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone];

  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">{label}</p>
      <p className={`tnum mt-1.5 text-2xl font-semibold ${toneClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'brand' | 'warning' | 'danger' | 'info';
}) {
  const toneClass = {
    neutral: 'bg-surface-muted text-text-secondary',
    brand: 'bg-brand/12 text-brand',
    warning: 'bg-warning/12 text-warning',
    danger: 'bg-danger/12 text-danger',
    info: 'bg-info/12 text-info',
  }[tone];

  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${toneClass}`}>
      {children}
    </span>
  );
}

export function TagBadge({ tag }: { tag: ProductivityTag }) {
  const tone = {
    Productive: 'brand',
    Unproductive: 'warning',
    Blacklisted: 'danger',
    Neutral: 'neutral',
  }[tag] as 'brand' | 'warning' | 'danger' | 'neutral';

  return <Badge tone={tone}>{tag}</Badge>;
}

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const tone = {
    Information: 'info',
    Warning: 'warning',
    High: 'danger',
    Critical: 'danger',
  }[severity] as 'info' | 'warning' | 'danger';

  return <Badge tone={tone}>{severity}</Badge>;
}

/** A green/grey dot for liveness. Paired with text, never used as the only signal. */
export function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${online ? 'bg-brand' : 'bg-text-secondary/40'}`}
      aria-hidden
    />
  );
}

/**
 * Wraps a table in its own horizontal scroll container. Wide report tables must scroll
 * inside the card rather than making the whole page scroll sideways.
 */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-5 overflow-x-auto px-5">{children}</div>;
}

export function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`whitespace-nowrap border-b border-border pb-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children = null,
  align = 'left',
  muted = false,
  numeric = false,
}: {
  /** Optional so a nested/continuation row can render an empty spacer cell. */
  children?: ReactNode;
  align?: 'left' | 'right';
  muted?: boolean;
  numeric?: boolean;
}) {
  return (
    <td
      className={`border-b border-border/60 py-2.5 text-sm ${align === 'right' ? 'text-right' : 'text-left'} ${
        muted ? 'text-text-secondary' : 'text-text-primary'
      } ${numeric ? 'tnum' : ''}`}
    >
      {children}
    </td>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="py-8 text-center text-sm text-text-secondary">{message}</p>;
}

/**
 * Proportional productivity bar. Purely decorative reinforcement of the numbers beside it â€”
 * the segments carry a title attribute but the figures are always shown as text too, so the
 * information is never colour-only.
 */
export function ProductivityBar({
  productive,
  unproductive,
  neutral,
  blacklisted,
}: {
  productive: number;
  unproductive: number;
  neutral: number;
  blacklisted: number;
}) {
  const total = productive + unproductive + neutral + blacklisted;
  if (total <= 0) return <div className="h-1.5 rounded-full bg-surface-muted" />;

  const segments = [
    { value: productive, className: 'bg-brand', label: 'Productive' },
    { value: neutral, className: 'bg-text-secondary/40', label: 'Neutral' },
    { value: unproductive, className: 'bg-warning', label: 'Unproductive' },
    { value: blacklisted, className: 'bg-danger', label: 'Blacklisted' },
  ].filter((segment) => segment.value > 0);

  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-muted">
      {segments.map((segment) => (
        <div
          key={segment.label}
          className={segment.className}
          style={{ width: `${(segment.value / total) * 100}%` }}
          title={`${segment.label}: ${Math.round((segment.value / total) * 100)}%`}
        />
      ))}
    </div>
  );
}
