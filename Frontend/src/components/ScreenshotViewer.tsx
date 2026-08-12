'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatBytes, formatDateTime } from '@/lib/format';
import { screenshotImageUrl } from '@/lib/screenshots';
import type { ScreenshotRow } from '@/types/api';

/**
 * Full-screen screenshot viewer: zoom, pan, and step through the gallery.
 *
 * Rendered through a portal onto <body>. The gallery it opens from is an internally-scrolling
 * region inside a card, so a viewer rendered in place would be clipped by that container and
 * would scroll with it — the portal is what lets it cover the page.
 */

/**
 * Zoom is expressed as a multiplier of the fitted size, so 1 always means "the whole capture is
 * on screen". It never goes below that: an image smaller than its frame has nothing to pan to and
 * a viewer that can shrink it further just wastes the screen it was opened to fill.
 */
const MIN_ZOOM = 1;
/** A 1080p capture at 8x is roughly pixel-doubled — past that there is no more detail to reveal. */
const MAX_ZOOM = 8;
/** Multiplier per button press. Geometric so each step feels the same size at any zoom level. */
const ZOOM_STEP = 1.4;
/** Gentler per wheel notch, since a trackpad emits many of them for one gesture. */
const WHEEL_ZOOM_STEP = 1.12;

/** Pan is only possible once the image overflows its frame. */
const PANNABLE_ABOVE = MIN_ZOOM;

/**
 * Start loading the next page this many captures before the end, so stepping right with the
 * keyboard does not stall at the boundary waiting for a fetch.
 */
const PREFETCH_WITHIN = 3;

interface Point {
  x: number;
  y: number;
}

/** Scale plus a translation in CSS pixels, applied about the centre of the frame. */
interface View extends Point {
  scale: number;
}

const IDENTITY_VIEW: View = { scale: MIN_ZOOM, x: 0, y: 0 };
const CENTRE: Point = { x: 0, y: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface ScreenshotViewerProps {
  /** Every capture loaded so far. Grows as the gallery pages in more. */
  screenshots: ScreenshotRow[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Whether the feed has more captures past the last one loaded. */
  hasMore: boolean;
  /** Asks the gallery for the next page, so stepping right can continue past what is loaded. */
  onLoadMore: () => void;
}

export function ScreenshotViewer({
  screenshots,
  index,
  onIndexChange,
  onClose,
  hasMore,
  onLoadMore,
}: ScreenshotViewerProps) {
  const [view, setView] = useState<View>(IDENTITY_VIEW);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  const frameRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const current = screenshots[index];

  /**
   * Keeps the image from being dragged out of its own frame.
   *
   * The bound is half the overflow on each axis: at 1x there is no overflow, so both collapse to
   * zero and the image re-centres itself — which is also what makes "reset" need no special case.
   */
  const clampView = useCallback((next: View): View => {
    const frame = frameRef.current;
    const image = imageRef.current;
    if (!frame || !image) return next;

    // offsetWidth is the *fitted* size: the transform scales the painted result and leaves layout
    // untouched, so this stays the 1x size no matter how far the operator has zoomed in.
    const overflowX = Math.max(0, image.offsetWidth * next.scale - frame.clientWidth) / 2;
    const overflowY = Math.max(0, image.offsetHeight * next.scale - frame.clientHeight) / 2;

    return {
      scale: next.scale,
      x: clamp(next.x, -overflowX, overflowX),
      y: clamp(next.y, -overflowY, overflowY),
    };
  }, []);

  /**
   * Multiplies the zoom about a point, given in pixels from the centre of the frame.
   *
   * Anchoring matters: zooming about the centre while the operator is pointing at a corner walks
   * whatever they were inspecting off the screen, and they have to pan it back after every step.
   * Buttons and the keyboard pass no anchor and so zoom about the centre, which is what the
   * absence of a pointer position means.
   *
   * Always applied through the updater, never from `view` in a closure: a trackpad delivers a
   * burst of wheel events between two renders, and each one computing its target from the same
   * stale scale would throw away all but the last.
   */
  const zoomBy = useCallback(
    (factor: number, anchor: Point = CENTRE) => {
      setView((previous) => {
        const scale = clamp(previous.scale * factor, MIN_ZOOM, MAX_ZOOM);
        if (scale === previous.scale) return previous;

        // The image point under the anchor must stay under it: solve
        // anchor = offset' + scale' * (anchor - offset) / scale for offset'.
        return clampView({
          scale,
          x: anchor.x - ((anchor.x - previous.x) * scale) / previous.scale,
          y: anchor.y - ((anchor.y - previous.y) * scale) / previous.scale,
        });
      });
    },
    [clampView]
  );

  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);
  const resetView = useCallback(() => setView(IDENTITY_VIEW), []);

  const canPrevious = index > 0;
  const canNext = index < screenshots.length - 1;

  const goPrevious = useCallback(() => {
    if (index > 0) onIndexChange(index - 1);
  }, [index, onIndexChange]);

  const goNext = useCallback(() => {
    if (index < screenshots.length - 1) onIndexChange(index + 1);
  }, [index, onIndexChange, screenshots.length]);

  // Stepping right towards the end of what is loaded pulls in the next page, so the gallery's
  // infinite scroll applies to keyboard navigation too rather than dead-ending at page one.
  useEffect(() => {
    if (hasMore && index >= screenshots.length - PREFETCH_WITHIN) onLoadMore();
  }, [hasMore, index, onLoadMore, screenshots.length]);

  // A different capture is a different image: the previous zoom and pan described a region of a
  // picture that is no longer on screen, so carrying them over lands the operator on a random
  // corner of the next one.
  //
  // Adjusted during render, not in an effect — an effect would paint one frame of the new image
  // transformed by the old view, which is a visible jump on every arrow press.
  const [shownId, setShownId] = useState(current?.id);
  if (current?.id !== shownId) {
    setShownId(current?.id);
    setView(IDENTITY_VIEW);
    setStatus('loading');
  }

  // The page behind the overlay must not scroll while it is open — the wheel belongs to the
  // viewer, and a scrolled-away background is disorienting on close.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Focus moves into the dialog on open and back to the tile that opened it on close, so keyboard
  // and screen-reader users are not left pointing at an element hidden behind the overlay.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Tab is kept inside the dialog: everything behind the overlay is inert to the mouse, and a
      // focus ring that wanders off into it has nowhere visible to go.
      if (event.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
        if (!focusable || focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;

        if (event.shiftKey && (active === first || active === dialogRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      // '=' and '_' are the unshifted and shifted faces of the same two keys — an operator
      // pressing shift-plus expects to zoom in, not to be told the key does nothing.
      const shortcuts: Record<string, (() => void) | undefined> = {
        Escape: onClose,
        ArrowLeft: goPrevious,
        ArrowRight: goNext,
        '+': zoomIn,
        '=': zoomIn,
        '-': zoomOut,
        _: zoomOut,
        '0': resetView,
      };

      const handler = shortcuts[event.key];

      if (!handler) return;
      event.preventDefault();
      handler();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goNext, goPrevious, onClose, resetView, zoomIn, zoomOut]);

  /** Pointer position relative to the centre of the frame, which is what zoomTo anchors on. */
  const anchorFromEvent = useCallback((event: { clientX: number; clientY: number }): Point => {
    const frame = frameRef.current;
    if (!frame) return CENTRE;

    const bounds = frame.getBoundingClientRect();
    return {
      x: event.clientX - (bounds.left + bounds.width / 2),
      y: event.clientY - (bounds.top + bounds.height / 2),
    };
  }, []);

  // The gesture itself is a ref (it changes on every pointermove and must not drive a render of
  // its own), but *whether* one is in progress is state: the cursor and the transform's
  // transition both depend on it, and a ref cannot repaint them.
  const drag = useRef<{ pointerId: number; from: Point; origin: Point } | null>(null);
  const [panning, setPanning] = useState(false);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (view.scale <= PANNABLE_ABOVE) return;

    // Capture so a fast drag that leaves the frame keeps panning instead of stopping dead, and
    // still delivers the pointerup that ends it.
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      from: { x: event.clientX, y: event.clientY },
      origin: { x: view.x, y: view.y },
    };
    setPanning(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const panning = drag.current;
    if (!panning || panning.pointerId !== event.pointerId) return;

    setView((previous) =>
      clampView({
        scale: previous.scale,
        x: panning.origin.x + (event.clientX - panning.from.x),
        y: panning.origin.y + (event.clientY - panning.from.y),
      })
    );
  }

  function endPan(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setPanning(false);
  }

  function onWheel(event: React.WheelEvent<HTMLDivElement>) {
    // deltaY sign, not magnitude: a mouse reports ~100 per notch and a trackpad single digits, so
    // scaling by the value makes the same gesture behave completely differently on each.
    zoomBy(event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP, anchorFromEvent(event));
  }

  if (!current) return null;

  const zoomed = view.scale > PANNABLE_ABOVE;

  const overlay = (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Screenshot from ${formatDateTime(current.capturedAt)}`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm outline-none"
      // Clicking the backdrop closes, but only the backdrop: the check keeps a pan that happens to
      // end outside the image from dismissing the viewer mid-gesture.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 px-4 py-3 text-white">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{formatDateTime(current.capturedAt)}</p>
          <p className="truncate text-xs text-white/60">
            {current.deviceName ?? 'Unknown device'}
            {current.width && current.height ? ` · ${current.width}×${current.height}` : ''}
            {` · ${formatBytes(current.sizeBytes)}`}
          </p>
        </div>

        <p className="tnum text-xs text-white/60" aria-live="polite">
          {index + 1} of {screenshots.length}
          {hasMore ? '+' : ''}
        </p>

        <div className="ml-auto flex items-center gap-1">
          <ToolbarButton onClick={zoomOut} disabled={view.scale <= MIN_ZOOM} label="Zoom out">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M8 11h6M20 20l-4.35-4.35" />
            </svg>
          </ToolbarButton>

          {/* The percentage is text, not a tooltip: it is the only way to tell 2x from 3x on a
              screenshot of a screen, which looks much the same at either. */}
          <span className="tnum w-14 text-center text-xs text-white/70">
            {Math.round(view.scale * 100)}%
          </span>

          <ToolbarButton onClick={zoomIn} disabled={view.scale >= MAX_ZOOM} label="Zoom in">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M11 8v6M8 11h6M20 20l-4.35-4.35" />
            </svg>
          </ToolbarButton>

          <ToolbarButton
            onClick={resetView}
            disabled={view.scale === MIN_ZOOM && view.x === 0 && view.y === 0}
            label="Reset zoom"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </ToolbarButton>

          <ToolbarButton onClick={onClose} label="Close viewer">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </ToolbarButton>
        </div>
      </header>

      <div className="relative flex-1 overflow-hidden">
        <div
          ref={frameRef}
          className="absolute inset-0 touch-none select-none"
          style={{ cursor: zoomed ? (panning ? 'grabbing' : 'grab') : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onWheel={onWheel}
          // Double-click toggles between fitted and a useful magnification — the fastest way to
          // read a window title without three presses of the zoom button.
          onDoubleClick={(event) =>
            zoomed ? resetView() : zoomBy(ZOOM_STEP * ZOOM_STEP, anchorFromEvent(event))
          }
        >
          {status === 'loading' && (
            <p className="absolute inset-0 grid place-items-center text-sm text-white/60">Loading…</p>
          )}

          {status === 'failed' ? (
            <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/70">
              This screenshot could not be loaded. It may have been removed by the retention policy.
            </p>
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element -- the proxy streams an
               already-stored JPEG from behind a session cookie; next/image would add an optimizer
               pass over bytes it cannot cache, and the viewer needs the original pixels anyway. */
            <img
              ref={imageRef}
              src={screenshotImageUrl(current)}
              alt={`Screen capture from ${current.deviceName ?? 'an unknown device'} at ${formatDateTime(current.capturedAt)}`}
              draggable={false}
              onLoad={() => setStatus('ready')}
              onError={() => setStatus('failed')}
              className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
              style={{
                transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
                // Instant while dragging, eased for a zoom step — a transition on a pan turns the
                // image into a rubber band that lags the pointer.
                transition: panning ? 'none' : 'transform 120ms ease-out',
                visibility: status === 'ready' ? 'visible' : 'hidden',
              }}
            />
          )}
        </div>

        <EdgeButton side="left" onClick={goPrevious} disabled={!canPrevious} label="Previous screenshot" />
        <EdgeButton
          side="right"
          onClick={goNext}
          disabled={!canNext}
          label={hasMore && !canNext ? 'Loading more screenshots' : 'Next screenshot'}
        />
      </div>

      <footer className="px-4 py-2 text-center text-[11px] text-white/40">
        ← → to move between captures · + − to zoom · 0 to reset · drag to pan · Esc to close
      </footer>
    </div>
  );

  return createPortal(overlay, document.body);
}

function ToolbarButton({
  onClick,
  disabled = false,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function EdgeButton({
  side,
  onClick,
  disabled,
  label,
}: {
  side: 'left' | 'right';
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white/90 transition-colors hover:bg-black/70 disabled:pointer-events-none disabled:opacity-0 ${
        side === 'left' ? 'left-3' : 'right-3'
      }`}
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
        <path d={side === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
      </svg>
    </button>
  );
}
