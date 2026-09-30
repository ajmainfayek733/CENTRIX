# Live updates and bounded log windows

Two mechanisms with different guarantees: a socket that says *something changed*, and scroll
windows that fetch one bounded page at a time.

Source: `Frontend/src/components/RealtimeProvider.tsx`, `Frontend/src/lib/use-log-feed.ts`,
`Frontend/src/lib/realtime.ts`, `Frontend/src/components/LogScroller.tsx`.

---

## 1. Two kinds of update, only one of them rate-limited

`RealtimeProvider` wraps the whole dashboard and handles both.

### Presence - applied instantly

Device liveness, "Active now", the online count. Applied to React state the moment an event
arrives. Nothing deferred, nothing polled. This is the part that has to feel live, and it does.

### Report data - refreshed via `router.refresh()`

Overview totals, rosters, log tables. `router.refresh()` re-runs the server components for the
current route and streams new HTML in **without a navigation or a reload**.

The socket deliberately does not carry these rows. A socket-fed client cache drifts from the
database and has to be reconciled after every missed event, reconnect and permission change.
Re-reading from the API keeps one source of truth.

### The rate limit is a debounce, not a schedule

`REFRESH_MIN_INTERVAL_MS` = 15s.

**Nothing runs on a timer when nothing is happening.** A refresh is only ever triggered by an
event. The limit caps how often events may cause a refetch: a hundred agents on a two-minute cycle
produce clustered bursts of `telemetry:ingested`, and refreshing per event would mean several full
server-component renders per second - more expensive than the polling this replaced.

**It fires on the leading edge.** The first event after a quiet period refreshes immediately; only
a burst behind it is collapsed into one trailing refresh. A trailing-only debounce would delay
every update by the full window, including a lone event on a quiet system - the case where the
dashboard most obviously ought to feel instant.

## 2. Totals move without a refetch

`telemetry:ingested` carries the **delta** the batch produced, so `LiveTotals` adds it to what is
already on screen. The figures do not wait for the 15-second window; only things a delta cannot
express do - a new row in a log table, a device changing hands, an employee being added.

Deltas are safe to apply blind because they are relative: a screen showing any date range, filter
or employee subset can add what just arrived and still be correct.

`eventCount` is zero for a replay, so a replayed batch moves nothing. `workDates` lets a screen
showing one date ignore a backfill for another.

**All twelve fields of `RollupDeltaPayload` must exist on both sides.** A field present on one side
only is added as `undefined` into a running total and turns it into `NaN`.

## 3. "Active now" is derived from heartbeats

`live` comes from a heartbeat having arrived within `maxSilenceMs` - **not** from a socket
existing. A half-open connection outlives an unplugged cable or a suspended laptop by minutes, so
connection state alone would keep a dead machine green.

`maxSilenceMs` is supplied by the server in the presence snapshot rather than hardcoded here, so
changing the heartbeat interval in admin config does not need a frontend release for the two to
stay consistent.

On connect the server sends a **full presence snapshot**, because devices that connected before
this browser did will not heartbeat again for up to a full interval - and until then a freshly
opened tab would show the whole fleet offline.

## 4. Reconnection

Exponential backoff from `RECONNECT_MIN_MS` (1s) to `RECONNECT_MAX_MS` (30s). A dropped socket
degrades the dashboard to manual refresh; it never breaks it, because the socket was never the
source of the data.

`ConnectionBanner` tells the operator when live updates are not flowing, so a stale screen is
never silently stale.

## 5. Log windows are fixed-height and paged

Every feed - activity timeline, alerts, USB, screenshots - renders a **fixed-height scroll window**
that holds one page at a time and asks for the next when the reader nears the bottom.

`use-log-feed.ts` is a hook rather than a component because the behaviour (cursor, de-duplication,
in-flight guard, sentinel observer) is identical across feeds while the markup is not: one is rows
in a `<table>`, another is cells in a grid that also hands loaded rows to a full-screen viewer.

| Detail | Value | Why |
|---|---|---|
| First page | Fetched **on the server** | The window is populated before any JavaScript runs |
| Trigger | `IntersectionObserver` on a sentinel | No per-scroll-event calculation |
| Prefetch margin | `200px` | The next page is usually there by the time the reader arrives |
| Page size | Decided by the **server** from policy | The client only ever asks for "the next page" |
| De-duplication | By `rowKey` | A live feed can deliver a row twice around a cursor boundary |

**The observer must be rooted to the scroll container, not the viewport.** These windows scroll
internally, so a default-root observer never fires and paging silently stops.

The employee timeline previously did `take: 2000` and handed the lot to the browser. That is both
an unbounded read as history grows and 2,000 rows rendered into a page nobody scrolls to the end
of.

Feed names in `LogFeedName` must stay in step with the allowlist in
`Frontend/src/app/api/logs/[feed]/route.ts`.

---

## Failure modes

| Symptom | Likely cause | Check |
|---|---|---|
| Nothing updates live, refresh works | Event-name drift, or `realtimeEnabled` off in policy | Compare `lib/realtime.ts` with `Backend/src/realtime/events.ts` |
| Totals become `NaN` | `RollupDeltaPayload` field missing on one side | Both must carry twelve fields |
| Totals drift upward over a session | A delta applied twice, or a replay not carrying `eventCount: 0` | Payload must be relative |
| Devices stay green after being unplugged | Liveness derived from connection instead of heartbeat | `live` must come from heartbeat age |
| Whole fleet shows offline on a fresh tab | Snapshot not received | Server log at connect |
| Scrolling never loads more | Observer rooted to the viewport instead of the container | `LogScroller` root option |
| Rows repeat while scrolling | Cursor not `(timestamp, id)`, or `rowKey` not unique | [../backend/reporting.md](../backend/reporting.md) section 2 |
| Screenshot grid very slow | `screenshotPageSize` raised toward `logPageSize` | They are separate settings on purpose |
| Dashboard busy at idle | A refresh on a timer instead of on an event | The debounce must be event-triggered only |

---

## Related

- [../backend/realtime.md](../backend/realtime.md) - the emitting side
- [../backend/reporting.md](../backend/reporting.md) - keyset pagination
- [session-and-auth.md](session-and-auth.md) - how the socket is authenticated
- [resilience.md](resilience.md) - when the feed cannot be fetched at all
- [../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md) - section 5
