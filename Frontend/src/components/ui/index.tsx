import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { ProductivityTag, AlertSeverity } from "@/types/api";

/**
 * The dashboard's whole component vocabulary. Hand-rolled rather than pulled from a component
 * library: every element here resolves its colours from the CSS variables in globals.css, so
 * light and dark stay in step without a second set of class names.
 *
 * Two colour families run through this file and they never mix:
 *
 *   brand   - sky blue. "You can act on this." Links, navigation, primary buttons, focus.
 *   success - green.    "This is productive / this is online." A reading, never a control.
 *
 * They were a single token before, which left a productive-time percentage and a submit button
 * wearing the same colour and meaning different things by it.
 *
 * Surfaces here are translucent but never blurred. The frosted `.glass` treatment is spent on
 * the persistent shell only - see the note in globals.css.
 */

/* ------------------------------------------------------------------ containers */

export function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-glass-border bg-surface shadow-glass-sm",
        className,
      )}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-4 border-b border-border bg-surface-muted px-4.5 py-3.25">
          {title && <h2 className={cn(LABEL_CLASS, "text-text-secondary")}>{title}</h2>}
          {action}
        </header>
      )}

      <div className="min-w-0 p-4.5">{children}</div>
    </section>
  );
}

/**
 * The screen's heading block. Every page opened with a hand-built copy of this before, at
 * `text-lg` - the same weight as the body text underneath it, which left the screens with no
 * entry point for the eye.
 */
export function PageHeader({
  title,
  subtitle,
  action,
  back,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <div className="mb-[18px]">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.5px] text-text-primary">{title}</h1>
          {subtitle && <p className="mt-[3px] text-[13.5px] text-text-secondary">{subtitle}</p>}
        </div>
        {action}
      </div>
    </div>
  );
}

/** The small uppercase label used for card titles, tile labels and table headings alike. */
const LABEL_CLASS = "text-[11px] font-medium uppercase tracking-[0.06em]";

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className={cn(LABEL_CLASS, "mb-2.5 text-text-tertiary")}>{children}</h3>;
}

/* ------------------------------------------------------------------ readings */

type Tone = "default" | "brand" | "success" | "warning" | "danger";

const VALUE_TONE: Record<Tone, string> = {
  default: "text-text-primary",
  brand: "text-brand",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/** A single headline number. The overview is built from a row of these. */
export function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg border border-glass-border bg-surface px-[18px] py-4 shadow-glass-sm transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-glass-lift">
      <p className={cn(LABEL_CLASS, "mb-[7px] text-text-tertiary")}>{label}</p>
      <p
        className={cn(
          "tnum text-[26px] font-semibold leading-[1.1] tracking-[-0.7px]",
          VALUE_TONE[tone],
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-[5px] text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

/** The oversized percentage that opens a productivity card, with its qualifier inline. */
export function HeroPercent({ value, caption }: { value: string; caption: string }) {
  return (
    <p className="mb-[3px] text-[30px] font-semibold leading-tight tracking-[-0.9px] text-text-primary">
      <span className="tnum">{value}</span>{" "}
      <span className="text-sm font-normal tracking-normal text-text-secondary">{caption}</span>
    </p>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "success" | "warning" | "danger" | "info";
}) {
  const toneClass = {
    neutral: "bg-surface-muted text-text-secondary",
    brand: "bg-brand/12 text-brand",
    success: "bg-success/14 text-success",
    warning: "bg-warning/14 text-warning",
    danger: "bg-danger/14 text-danger",
    info: "bg-info/12 text-info",
  }[tone];

  return (
    <span
      className={cn(
        "inline-block whitespace-nowrap rounded-full px-[9px] py-[3px] text-[11.5px] font-medium",
        toneClass,
      )}
    >
      {children}
    </span>
  );
}

export function TagBadge({ tag }: { tag: ProductivityTag }) {
  const tone = {
    Productive: "success",
    Unproductive: "warning",
    Blacklisted: "danger",
    Neutral: "neutral",
  }[tag] as "success" | "warning" | "danger" | "neutral";

  return <Badge tone={tone}>{tag}</Badge>;
}

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const tone = {
    Information: "info",
    Warning: "warning",
    High: "danger",
    Critical: "danger",
  }[severity] as "info" | "warning" | "danger";

  return <Badge tone={tone}>{severity}</Badge>;
}

/** A green/grey dot for liveness. Paired with text, never used as the only signal. */
export function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        online ? "bg-success-vivid" : "bg-neutral-dot",
      )}
      aria-hidden
    />
  );
}

/* ------------------------------------------------------------------ tables */

/**
 * Wraps a table in its own horizontal scroll container, bled out to the card's edges so the
 * heading row's tint spans the full width. Wide report tables must scroll inside the card
 * rather than making the whole page scroll sideways.
 *
 * The negative margin cancels Card's padding, so this belongs to a table that is its card's
 * only child - which is how every table in this dashboard is arranged.
 */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-m-4.5 min-w-0 overflow-x-auto">{children}</div>;
}

/**
 * Row hover and the borderless last row are applied here rather than on every <tr>, because a
 * <tr> cannot paint a background across cells reliably - the cells have to carry it.
 */
export const TABLE_CLASS =
  "w-full min-w-180 table-fixed border-separate border-spacing-0 [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:hover_td]:bg-row-hover";

export function Th({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        LABEL_CLASS,
        "whitespace-nowrap border-b border-border bg-th-bg px-3.75 py-2.5 text-text-tertiary",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children = null,
  align = "left",
  muted = false,
  numeric = false,
}: {
  /** Optional so a nested/continuation row can render an empty spacer cell. */
  children?: ReactNode;
  align?: "left" | "right";
  muted?: boolean;
  numeric?: boolean;
}) {
  return (
    <td
      className={cn(
        "border-b border-border px-[15px] py-3 align-middle text-[13.5px] transition-colors",
        align === "right" ? "text-right" : "text-left",
        muted ? "text-text-tertiary" : "text-text-primary",
        numeric && "tnum",
      )}
    >
      {children}
    </td>
  );
}

/** The name-plus-status cell that opens most rows. */
export function EntityCell({
  online,
  name,
  sub,
  href,
}: {
  online?: boolean;
  name: ReactNode;
  sub?: ReactNode;
  href?: string;
}) {
  const label = (
    <span className="block truncate font-medium">
      {name}
      {sub && <span className="mt-px block text-xs font-normal text-text-tertiary">{sub}</span>}
    </span>
  );

  return (
    <div className="flex items-center gap-2.5">
      {online !== undefined && <StatusDot online={online} />}
      {href ? (
        /* next/link, not a bare anchor: these cells are the main way into a detail screen and
           a plain href would tear the app shell down and re-fetch it on every click. */
        <Link href={href} className="min-w-0 text-brand hover:underline">
          {label}
        </Link>
      ) : (
        <span className="min-w-0">{label}</span>
      )}
    </div>
  );
}

export function EmptyState({ message, icon }: { message: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      {icon && (
        <span
          className="grid size-10 place-items-center rounded-md bg-brand-soft text-brand"
          aria-hidden
        >
          {icon}
        </span>
      )}
      <p className="max-w-md text-sm text-text-secondary">{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ productivity */

/** The four productivity segments plus idle, in the one order used everywhere they appear. */
const SEGMENT_STYLE = {
  productive: "bg-success-vivid",
  neutral: "bg-neutral-dot",
  unproductive: "bg-warning",
  blacklisted: "bg-danger",
  idle: "bg-border-strong",
} as const;

export type SegmentKey = keyof typeof SEGMENT_STYLE;

/**
 * Proportional productivity bar. Purely decorative reinforcement of the numbers beside it -
 * the segments carry a title attribute but the figures are always shown as text too, so the
 * information is never colour-only.
 */
export function ProductivityBar({
  productive,
  unproductive,
  neutral,
  blacklisted,
  size = "md",
}: {
  productive: number;
  unproductive: number;
  neutral: number;
  blacklisted: number;
  size?: "sm" | "md";
}) {
  const track = cn(
    "flex overflow-hidden rounded-full bg-surface-muted",
    size === "sm" ? "h-[5px]" : "h-[7px]",
  );
  const total = productive + unproductive + neutral + blacklisted;
  if (total <= 0) return <div className={track} />;

  const segments: { value: number; key: SegmentKey; label: string }[] = [
    { value: productive, key: "productive", label: "Productive" },
    { value: neutral, key: "neutral", label: "Neutral" },
    { value: unproductive, key: "unproductive", label: "Unproductive" },
    { value: blacklisted, key: "blacklisted", label: "Blacklisted" },
  ];

  return (
    <div className={track}>
      {segments
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <div
            key={segment.key}
            className={SEGMENT_STYLE[segment.key]}
            style={{ width: `${(segment.value / total) * 100}%` }}
            title={`${segment.label}: ${Math.round((segment.value / total) * 100)}%`}
          />
        ))}
    </div>
  );
}

/** The dot-label-value row that explains a productivity bar. */
export function Legend({ items }: { items: { key: SegmentKey; label: string; value: string }[] }) {
  return (
    <dl className="flex flex-wrap gap-x-[18px] gap-y-2.5">
      {items.map((item) => (
        <div key={item.key} className="flex items-center gap-[7px] text-[12.5px]">
          <span
            className={cn("size-[7px] shrink-0 rounded-full", SEGMENT_STYLE[item.key])}
            aria-hidden
          />
          <dt className="text-text-secondary">{item.label}</dt>
          <dd className="tnum font-medium text-text-primary">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ controls */

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background,color,opacity,box-shadow] cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_VARIANT = {
  /* A gradient of the two deeper blues rather than the bright accent: white text on #0ea5e9
     is about 2.8:1. The accent stays the accent everywhere it is a foreground colour. */
  primary:
    "bg-linear-135 from-brand-strong to-brand-strong-2 text-brand-contrast shadow-[0_4px_12px_rgba(14,120,200,0.3)] hover:opacity-92",
  secondary: "glass-control text-text-primary hover:bg-surface-strong",
  ghost: "text-text-secondary hover:bg-brand-soft hover:text-brand",
  danger: "bg-danger text-destructive-foreground hover:opacity-90",
} as const;

const BUTTON_SIZE = {
  sm: "px-[11px] py-[5px] text-xs",
  md: "px-4 py-2 text-[13px]",
} as const;

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & {
  variant?: keyof typeof BUTTON_VARIANT;
  size?: keyof typeof BUTTON_SIZE;
}) {
  return (
    <button
      {...props}
      className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
    />
  );
}

/** A round icon-only control, as used across the topbar. Requires an accessible name. */
export function IconButton({
  className,
  "aria-label": ariaLabel,
  ...props
}: ComponentProps<"button"> & { "aria-label": string }) {
  return (
    <button
      {...props}
      aria-label={ariaLabel}
      className={cn(
        "glass-control relative grid size-9 shrink-0 place-items-center rounded-full text-text-secondary transition-colors hover:text-brand",
        className,
      )}
    />
  );
}

export const INPUT_CLASS =
  "w-full rounded-md border border-border-strong bg-surface-strong px-3 py-2 text-[13.5px] text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-brand";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...props} className={cn(INPUT_CLASS, className)} />;
}

/** Label-above-control pairing. The label is bound by the caller's `htmlFor`/`id`. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-text-secondary">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-text-tertiary">{hint}</p>}
    </div>
  );
}

/** An inline informational panel - policy notices, degraded-mode explanations. */
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning";
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-4 py-[13px] text-[13px] leading-relaxed",
        tone === "warning"
          ? "border-warning/40 bg-warning/10 text-text-primary"
          : "border-border-strong bg-surface-muted text-text-secondary",
      )}
    >
      {children}
    </div>
  );
}

/**
 * A placeholder block for content that has not arrived. Sized by the caller so a skeleton can
 * match the shape of what replaces it, rather than being a generic grey box.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-muted", className)} aria-hidden />;
}

export { ToastProvider, useToast, type ToastTone } from "./Toast";
export { Modal, ConfirmModal, type ModalProps, type ConfirmModalProps } from "./Modal";

