> **STATUS: original governing specification.** Written before the code existed, and parts of it
> have been overtaken by the implementation. It is kept because it states the *intent* behind the
> design and because sections 12-15 are current and detailed.
>
> **Where the code has moved on:**
>
> | This document says | The code does |
> |---|---|
> | `middleware.ts` (section 5) | `Frontend/src/proxy.ts` |
> | `hooks/` (section 7) | `src/lib/` - for example `use-log-feed.ts` |
>
> For what the code does **now**, start at [README.md](README.md). This file is the reasoning
> behind it, not a description of it.

---

# AGENTS.md - Monitoring Dashboard (Next.js)

Governing spec for the dashboard repo, App Router edition. Read before writing code
in any folder below. This repo is the **read path only** - it never talks to agents,
never handles device tokens, and every request it makes carries a manager/HR user's
session. If you find yourself adding device-token logic here, stop - that belongs in
`monitoring-server`, not this repo.

---

## 1. Scope and stack reality-check

- **Next.js App Router**, not Pages Router - routes live under `app/`, layouts and
  server components are the default, client components are the exception (opted into
  with `'use client'`).
- This dashboard is a **client of `monitoring-server`**, not a full-stack app in its
  own right. It has no database connection of its own and no Prisma schema - every
  piece of data comes from the Express API. Next.js's server-side capabilities here
  are used for two things only: server-rendering the initial page (faster first
  paint, and it lets you keep the session token in an httpOnly cookie instead of
  browser-readable storage - see section 3) and proxying auth.
- **Do not** reach for Next.js API routes to reimplement business logic that already
  exists in `monitoring-server`. If you find yourself writing a route handler that
  queries a database, you've drifted into rebuilding the backend inside the frontend
  repo - the only backend-shaped code that belongs here is the thin auth proxy in section 3.

---

## 2. Folder structure

```
Frontend/
+-- src/
|   +-- app/
|   |   +-- layout.tsx
|   |   +-- page.tsx                          # landing/redirect
|   |   +-- login/
|   |   |   +-- page.tsx
|   |   +-- (dashboard)/                      # route group, RBAC-protected
|   |   |   +-- layout.tsx                    # session check + role gate
|   |   |   +-- overview/
|   |   |   |   +-- page.tsx
|   |   |   +-- employees/
|   |   |   |   +-- page.tsx                  # roster list
|   |   |   |   +-- [employeeId]/
|   |   |   |       +-- page.tsx              # detail/timeline
|   |   |   +-- reports/
|   |   |   |   +-- page.tsx
|   |   |   +-- settings/
|   |   |       +-- categories/page.tsx
|   |   |       +-- retention/page.tsx
|   |   |       +-- users/page.tsx
|   |   +-- api/                              # thin BFF proxy only (optional)
|   |       +-- auth/[...nextauth]/route.ts   # if using NextAuth
|   +-- components/                           # shared, presentational only
|   |   +-- ui/
|   |   |   +-- Table.tsx
|   |   |   +-- Chart.tsx
|   |   |   +-- Card.tsx
|   |   +-- guards/RoleGuard.tsx
|   +-- features/                             # feature-scoped components/hooks
|   |   +-- overview/TeamSummaryCard.tsx
|   |   +-- employees/
|   |   |   +-- ActivityTimeline.tsx
|   |   |   +-- useEmployeeData.ts
|   |   +-- reports/ExportButton.tsx
|   |   +-- settings/CategoryRuleForm.tsx
|   +-- lib/
|   |   +-- api-client.ts                     # typed fetch wrapper -> Backend REST API
|   |   +-- auth.ts                           # session/JWT helpers
|   |   +-- constants.ts
|   +-- store/                                # Zustand/RTK client state
|   |   +-- auth.slice.ts
|   |   +-- employees.slice.ts
|   |   +-- settings.slice.ts
|   +-- types/                                # or import from shared/contracts
|   +-- middleware.ts                         # Next.js middleware - auth/RBAC redirects
+-- public/
+-- next.config.js
+-- tsconfig.json
+-- tests/
    +-- employees.test.tsx
    +-- activity-timeline.test.tsx
```

---

## 3. Auth: httpOnly cookie, not localStorage

This is the one meaningful change from a Vite/SPA setup, and it's a real security
improvement worth keeping:

1. `app/api/auth/login/route.ts` receives the login form submission, calls
   `monitoring-server`'s `/v1/dashboard/auth/login`, and on success sets the JWT it
   gets back as an **httpOnly, secure, sameSite=lax cookie** - never exposed to
   client-side JS. This closes the XSS-can-steal-the-token gap the Vite version
   explicitly accepted as a tradeoff.
2. `middleware.ts` runs on every request to a protected route, reads the cookie,
   verifies it (or does a lightweight decode + expiry check - full verification can
   stay server-side per-request), and redirects to `/login` if missing/invalid.
3. **Server components** read the cookie via `cookies()` from `next/headers` and
   attach it as the `Authorization` header when calling `monitoring-server` - this
   happens server-side, so the token never touches the browser as a JS-readable
   value at all.
4. **Client components** (interactive filters, buttons) never need the token
   directly - they call a Next.js route handler (`app/api/...`) or a server action,
   which reads the cookie server-side and forwards the request. A client component
   should never construct an `Authorization` header itself.

```typescript
// lib/api-client.ts - server-side only
import { cookies } from 'next/headers';

export async function serverFetch(path: string, init?: RequestInit) {
  const token = (await cookies()).get('session')?.value;
  return fetch(`${process.env.MONITORING_API_URL}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    cache: 'no-store', // activity data is live; don't let Next cache it silently
  });
}
```

**`cache: 'no-store'` is not optional here.** Next.js aggressively caches `fetch` by
default; an uncached team-summary report is the whole point of this dashboard, and a
stale cached read would show a manager yesterday's "who's online now."

---

## 4. Data fetching pattern

- **Server components** (default) fetch on the server for the initial page load -
  the Overview screen, Employee list, and Employee detail's initial timeline all load
  this way. This is where Next.js earns its keep over the Vite version: no client-side
  loading spinner on first paint, and the auth token never leaves the server.
- **Client components** handle anything interactive after that: date-range pickers,
  "refresh now," live filters. These call route handlers under `app/api/dashboard/*`
  (thin proxies to `monitoring-server`, reusing `serverFetch`) via
  `@tanstack/react-query` - same reasoning as the Vite version: consistent
  loading/error state across screens without hand-rolling it per component.
- **Rule of thumb**: if the data is needed to render the page at all, fetch it in the
  server component. If it only changes in response to a user action after the page is
  interactive, fetch it client-side through a route handler.

---

## 5. middleware.ts - route + RBAC gate

```typescript
export function middleware(request: NextRequest) {
  const session = request.cookies.get('session')?.value;
  const { pathname } = request.nextUrl;

  if (!session && pathname.startsWith('/(dashboard)')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const role = decodeRole(session); // lightweight decode, not full verify
  if (pathname.startsWith('/settings') && role !== 'super_admin') {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

export const config = { matcher: ['/((?!login|_next/static|_next/image).*)'] };
```

As with the Vite version: **this is UX, not the security boundary.** `monitoring-server`
re-checks RBAC on every request regardless (per that repo's `AGENTS.md` section 4) - this
middleware only prevents a manager from seeing a settings page that would 403 anyway.

---

## 6. components/ - same organization as before, framework-adjusted

- `dashboard/` - Overview screen widgets (server components by default).
- `employee-detail/` - timeline, app/site breakdown; the date-range picker inside it
  is a client component, the initial data table is a server component.
- `reports/` - filterable views; export buttons stay disabled/hidden until the
  backend endpoint exists (Phase 2, same as before).
- `ui/` - shadcn components, installed via the shadcn CLI, not hand-copied - keeps
  them updatable. See section 11 for the CLI/token setup.
  - `ui/index.tsx` is a pre-shadcn, hand-rolled barrel (`Card`, `Badge`, `StatTile`,
    `Th`/`Td`, ...). It still works and is still imported from `@/components/ui`, but it
    is **legacy**: prefer a CLI-installed component for anything new. Note the name
    collision - the barrel's `Card` and a future `@/components/ui/card` from the
    registry are different components. Import paths, not names, disambiguate them.

**Rule carried over unchanged**: no component fetches `monitoring-server` directly
with a raw `fetch`/`axios` call. Server components use `lib/api-client.ts`; client
components use a hook that calls a local route handler.

---

## 7. hooks/ - client-side only now

Since server components handle the initial load, hooks here are strictly for
post-load, client-side interactivity:

| Hook | Wraps | Notes |
|---|---|---|
| `useTeamSummaryRefresh.ts` | `GET /api/dashboard/reports/team-summary` (local route handler) | Powers a manual refresh / polling toggle on the Overview screen |
| `useEmployeeTimelineFilter.ts` | `GET /api/dashboard/employees/:id/timeline` | Re-fetches when the date range changes |
| `useAuditLog.ts` | `GET /api/dashboard/audit-log` | Auditor + super_admin only |

There is no `useAuth.ts` client hook anymore - auth state lives in the httpOnly
cookie and is read server-side; a client component that needs to know the current
role reads it from a server component prop (passed down from the layout, which
decoded it server-side), not from client-side state.

---

## 8. types/ - unchanged in purpose

Still mirrors `monitoring-server`'s DTOs field-for-field (see that repo's `AGENTS.md`
section 7). Same warning as before: a drifted type here doesn't fail the build, it silently
renders `undefined` in a report. Treat contract changes as a two-repo commit.

---

## 9. Phase mapping (month-1 MVP)

| Component | Priority | Month-1? |
|---|---|---|
| Login route + httpOnly cookie + `middleware.ts` gate | M | **Yes** |
| Overview screen (server component) | M | **Yes** |
| Employee list (server component) | M | **Yes** |
| Employee detail - timeline, active/idle split | M | **Yes** |
| RBAC gating (Admin + Manager only) | M | **Yes** - Auditor can wait |
| Date-range filtering (client component + route handler) | M | **Yes**, basic ranges |
| CSV/PDF export buttons | S | Defer - hide, don't ship broken |
| Screenshot viewer | S | Defer |
| Auditor-specific views | S | Defer |
| Settings screen | M (per original spec) | Partial - categories only if time allows; retention/work-hours can defer to direct DB config |

---

## 10. Definition of done (month-1 MVP)

- A manager can log in; the session cookie is httpOnly and never appears in
  browser-accessible storage or client bundle.
- Initial page loads (Overview, Employee list, Employee detail) render server-side
  with real data - no client-side spinner on first paint.
- `middleware.ts` blocks unauthenticated access to every `(dashboard)` route and
  blocks non-admins from `/settings`.
- No `fetch`/`axios` call to `monitoring-server` happens directly from a client
  component; every client-side data need goes through a local route handler.
- Report data is never served from Next.js's fetch cache - every load reflects the
  current state in Postgres.

---

## 11. Theming and shadcn/ui

`Frontend/components.json` configures the shadcn CLI (v4, `base-nova` style, Base UI
primitives, lucide icons, Tailwind v4 so `tailwind.config` is intentionally empty).
Install components with the CLI from **`Frontend/`**, never from the repo root:

```bash
cd Frontend
npx shadcn@latest add <component>
```

The repo-root `.mcp.json` starts the shadcn MCP server with the same working
directory, so its add-commands resolve against this `components.json` rather than
against a rootless project.

### Two token layers in `src/app/globals.css`

1. **The palette** - the real colours, defined once per theme. Source of truth.
2. **The shadcn contract** - the names shadcn components hardcode (`--card`,
   `--primary`, `--muted`, `--ring`, `--chart-*`, `--sidebar-*`), defined as `var()`
   aliases onto the palette.

Aliases are declared only in `:root` and never restated in `.dark`: they resolve at
use site, so overriding a palette token switches both layers at once. This depends on
`dark` sitting on `<html>` - the same element as `:root` - which is what the inline
theme script in `layout.tsx` does.

**Rules when editing the theme:**

- Change colours in the palette block only. Editing an alias decouples it from the
  palette and it will stop following dark mode.
- The product green is `--brand`/`--brand-contrast` (utilities `bg-brand`,
  `text-brand-contrast`, and the `brand` tone on `Badge`/`StatTile`). It is **not**
  `--accent`: shadcn reserves `--accent` for its subtle hover/highlight surface, and
  sharing the name turns every shadcn hover state solid green. `--primary` is aliased
  to `--brand`, so shadcn's default button is the product green.
- Font variables belong on `<html>` in `layout.tsx`, not `<body>`. `globals.css`
  resolves `font-sans` on the html element, and `@theme inline` inlines its values
  into utilities instead of exposing `--font-sans` as a readable custom property - so
  `font-family: var(--font-sans)` resolves to nothing and the page silently falls back
  to Times New Roman.
- Running `shadcn init` again will overwrite the palette with the preset's greyscale
  defaults. Use `add`, not `init`.
---

## 12. Live updates and bounded log windows

### 12.1 The dashboard updates without a refresh

`RealtimeProvider` wraps the `(dashboard)` route group and holds one Socket.IO connection to the
API's `/dashboard` namespace.

**The socket never carries rows.** It carries "something landed", and the provider calls
`router.refresh()`, which re-runs the server components for the current route and streams new HTML
in without a navigation or a reload. That keeps exactly one source of truth - the database, read
through the API - instead of a socket-fed client cache that drifts from it and has to be
reconciled. Every rule in section 3 and section 4 still holds: nothing here fetches the API directly.

Refreshes are **coalesced** to one per 3s window. A hundred agents on a two-minute cycle produce a
steady trickle of events, and refreshing per event would put the dashboard into a permanent
refetch loop costing more than the polling it replaced.

Every (re)connection also triggers one refresh: data may have changed while the socket was down,
and nothing announces what was missed.

**Authentication.** The browser must never hold the session token - it lives in an httpOnly cookie
precisely so page scripts cannot read it. `POST /api/realtime/ticket` (a route handler, so it runs
server-side and can read the cookie) exchanges it at the API for a short-lived ticket that can open
a socket and do nothing else. If the ticket call fails, the page still renders from its own
server-side fetch; it simply will not update on its own. **Live updates are never load-bearing.**

`useRealtime()` exposes `connectedDevices`. This is *not* an online indicator - a device is shown
as online from `lastSeen`. It answers only whether a force-sync would be delivered right now.

### 12.2 Log tables are fixed-height scroll windows

`LogScroller` renders a bounded window: the first page arrives with the server-rendered page, and
an `IntersectionObserver` on a sentinel fetches the next page when the operator scrolls to the end.

The paging itself lives in `lib/use-log-feed.ts` (`useLogFeed`), which `LogScroller` and the
screenshot gallery share. Cursor handling, the in-flight guard, duplicate rejection and the
sentinel observer are identical for a table and a grid; only the markup differs.

The employee timeline previously did `take: 2000` and handed the lot to the browser - an unbounded
query as history grows, and thousands of DOM nodes for rows nobody scrolls to.

- Page size is **not** decided in the component. The server reads it from `Policy.logPageSize`, so
  an admin changes it on the settings screen.
- Client components cannot hold the session token, so paging goes through `/api/logs/[feed]`,
  which attaches the credential server-side. That route resolves the feed through an **explicit
  allowlist**, not by interpolating the path segment - a catch-all proxy would be an open door
  onto every API endpoint.
- Cursors are opaque. The client hands back whatever `nextCursor` it was given, which is what lets
  the server change the sort key without a client release.
- Rows already held are dropped on append. The cursor makes duplicates impossible in a static
  feed, but this one is live: a row inserted above the cursor between requests can appear twice.
- Totals are never derived from loaded rows. They come from the daily rollup, so a "productivity %"
  describes the period rather than the first fifty rows. Counts in card titles say
  "showing N", not "N entries", because only one page is loaded.
- A new first page resets the window - but the incoming page is compared **by content**, not by
  object identity. `RealtimeProvider` calls `router.refresh()` on every ingest event and each
  refresh hands down a fresh object even when the first page is unchanged, so an identity check
  threw away every page the operator had scrolled in, roughly once a minute. The comparison covers
  `rows`/`nextCursor`/`hasMore` only: some endpoints wrap the page in metadata whose `period.end`
  is "now", which would otherwise report a change on every refresh.
- The reset is applied **during render**, not in an effect. React restarts the render with the new
  state, so the stale page is never painted; the same reset in an effect flashes the old range
  first.

### 12.3 Live activeness in the admin dashboard

`useDeviceLiveness(deviceId)` gives a component the current state of one workstation, updated by
heartbeat rather than by refresh. `LiveDeviceStatus` and `LiveStatusDot` render it on the Devices
screen; `LiveOnlineTile` renders the fleet count on the Overview.

Two sources, in order:

1. **Live presence from the socket** - seconds old by construction. Preferred whenever it exists.
2. **The server-rendered `lastSeen`** - the fallback for a device with no live channel: switched
   off, out of the office, or an agent whose network blocks websocket upgrades.

Three details that are easy to get wrong and are deliberate here:

- **Liveness expires client-side.** A device whose last heartbeat is older than the silence window
  stops counting as live even though no event said so. The event announcing a departure is exactly
  the one that cannot arrive when a machine vanishes - a laptop losing power sends no disconnect -
  so a UI that waits to be told would show it active indefinitely. A one-second ticker re-evaluates.
- **The presence table is cleared when this browser's socket drops**, not frozen. Holding the last
  known state would leave every device showing as it was at the moment contact was lost, with
  nothing to correct it. Stale green dots are worse than an honest fallback.
- **The online tile falls back to the server count rather than showing zero** when the socket is
  down. "No live channel" is not "nobody is working", and an operator seeing 0 would reasonably
  conclude the fleet was down.

`Policy.presenceHeartbeatSeconds` is on the settings screen. The silence window is derived from it
server-side and pushed to the client in the snapshot, so the two cannot drift.

---

## 13. Behaviour when the monitoring service is unavailable

The dashboard is a pure client of the Express API, so an API restart is a routine event it has to
survive without misleading anyone.

### 13.1 "Unreachable" and "unauthorised" are different errors

`lib/api-client.ts` throws two distinct types, and nothing may collapse them:

| Type | Raised for | Correct response |
|---|---|---|
| `ApiError` | 4xx | A verdict on the request. 401 means the session is over - redirect to `/login`. |
| `ApiUnavailableError` | transport failure, or any 5xx | Says nothing about the session. Show the outage; keep the user signed in. |

This is the bug that motivated the section. `getSessionUser()` used to catch *everything* and
return `null`, which the layout reads as "logged out" and answers with a redirect. So an API
restart signed out every open dashboard in the building and sent them to a page that could not
authenticate them either - an infrastructure outage presented as a credentials problem, with the
real cause nowhere on screen. Unavailability now propagates.

The same conflation existed on the login route, where it was worse: a 5xx from the API was
returned as `401 Invalid email or password`, telling people their password was wrong during an
outage. It now answers **503** with a message saying the credentials were not checked.

### 13.2 What the user sees

- **Dashboard layout** catches `ApiUnavailableError` and renders the shell - header, theme, and a
  `ServiceUnavailable` panel - rather than redirecting. The session survives the outage.
- **`(dashboard)/error.tsx`** catches anything a page throws, so one failing endpoint degrades one
  screen instead of blanking the app. It distinguishes an outage from a bug *by message*, because
  React strips server errors before they reach the client and `instanceof` cannot survive the
  boundary; anything unrecognised is treated as a bug, which is the safer way round.
- **`app/error.tsx`** is the last resort for the login screen and for failures in the dashboard
  layout itself, which sits above the boundary below it.
- **`ConnectionBanner`** appears after the realtime channel has been down for 10s. A frozen
  dashboard is the dangerous failure here: it looks exactly like a quiet afternoon, and someone
  will read it as "nobody is working". The grace period stops it flickering on every blip.
- **`LogScroller`** reports a 503 distinctly and keeps `hasMore` true, so scrolling retries.

Every message states that **agents keep recording locally and lose nothing**. That is the first
question anyone asks when this screen appears, and leaving it unanswered invites a panicked call.

### 13.3 Verified against a dead API

Run the built app against a port with nothing on it:

```bash
cd Frontend
$env:MONITORING_API_URL='http://127.0.0.1:5999'; npx next start -p 3099
```

Signing in reports the service as unavailable rather than rejecting the credentials, and a
dashboard route renders the degraded shell instead of bouncing to `/login`.

## 14. Screenshots

A per-employee gallery on the employee detail screen: `ScreenshotGallery` renders a 3-across grid,
two rows deep, that pages in more captures as the operator scrolls, and `ScreenshotViewer` opens
any tile full-screen with zoom, pan and left/right navigation.

### 14.1 The image proxy - why `<img>` cannot point at the API

The session token is in an httpOnly cookie (section 3) and an `<img src>` cannot carry an `Authorization`
header. The two obvious ways out are both worse: putting the token where JavaScript can read it
reopens the XSS exposure the cookie exists to close, and making the image endpoint public and
protecting it with an unguessable path is not protection at all for the most invasive data in the
product.

So tags point at `/api/screenshots/[deviceId]/[file]`, which attaches the credential server-side
and streams the response back. `lib/screenshots.ts` builds that URL, and the route imports the
extension from the same module so the two cannot drift.

- Both path segments are validated against a strict charset before use. They are opaque backend
  identifiers, so this costs nothing and stops the route becoming a way to address arbitrary
  upstream paths.
- The upstream request is what the backend audit-logs, so viewing an image still records who
  looked at what.
- Responses are `Cache-Control: private, max-age=300`. `private` because these are pictures of an
  employee's desktop and must never enter a shared cache. The short lifetime keeps zooming,
  panning and stepping back and forth from re-downloading a full-size capture the operator is
  already looking at - the audit entry for opening it has already been written.
- 401/403/404 are passed through unchanged rather than dressed up as failures, and a 5xx becomes a
  503, consistent with section 13. A tile whose image 403s shows as broken rather than loading forever.

### 14.2 Role gate

Screenshots are excluded from the Auditor role by spec section 6. `canViewScreenshots(role)` gates the
section, so the page never renders a gallery whose first page would 403 on arrival. The API remains
the enforcement point - the UI is agreeing with it, not implementing it. Verified by demoting a
session to `auditor`: the section disappears and a hand-made request to the proxy returns 403.

### 14.3 Page size is its own setting

The gallery loads `Policy.screenshotPageSize` captures at a time (default 12), not `logPageSize`
(default 50). Twelve fills the 3-across grid four rows deep - two screens of scrolling - while a
50-item page would have the browser download and decode fifty full-size JPEGs for one flick of the
scroll wheel. Both are editable on the settings screen, next to each other, so the difference is
visible rather than folklore.

### 14.4 The viewer

- **Zoom** is a multiplier of the fitted size, 1x-8x, geometric per step. Buttons and the keyboard
  zoom about the centre; the wheel and double-click zoom about the pointer, because zooming about
  the centre while someone points at a corner walks what they were inspecting off the screen.
- Wheel zoom uses the **sign** of `deltaY`, never the magnitude - a mouse reports ~100 per notch
  and a trackpad single digits, so scaling by the value makes one gesture behave like two devices.
- **Pan** is clamped to the image's own overflow, so it cannot be dragged out of its frame. At 1x
  the bound collapses to zero and the image re-centres, which is why "reset" needs no special case.
- Every zoom goes through the state updater, never through `view` in a closure: a trackpad delivers
  a burst of wheel events between two renders, and each computing its target from the same stale
  scale would throw away all but the last.
- The open capture is tracked **by id, not by index**. The feed is live - a capture taken while the
  viewer is open is prepended and shifts every index below it, which silently swapped the viewer to
  the neighbouring image and reset its zoom. The position is derived from the id.
- Stepping right within three captures of the end asks for the next page, so infinite scroll
  applies to keyboard navigation and not only to the grid.
- Keyboard: `<-`/`->` move, `+`/`-` zoom, `0` resets, `Esc` closes. Tab is trapped inside the dialog,
  focus moves in on open and returns to the tile that opened it, and body scroll is locked while it
  is up.
- Rendered through a portal onto `<body>`: the gallery is an internally-scrolling region inside a
  card, so a viewer rendered in place would be clipped by it.

## 15. The settings screen is split by who a setting acts on

`PolicyForm` renders three groups, not one list. The division is the point: "screenshot interval"
reprograms every agent in the building and changes what is recorded about people, while "screenshots
per page" changes how many pictures this browser downloads at once. Both used to sit in the same
undifferentiated list, where the only way to tell them apart was to already know.

| Group | Contains | Who it affects |
|---|---|---|
| **Agent policy** | Data collected, screenshot capture (interval + JPEG quality), idle threshold, desktop alerts, idle ladder, working hours | Every employee machine. Changes what is recorded. |
| **Dashboard** | Log rows per page, screenshots per page | This browser's read path only. No agent ever sees it. |
| **Advanced** | Retention, sync batch size and interval, realtime + presence heartbeat | Fleet-wide, or destructive. Collapsed by default. |

- **Advanced is collapsed** not because the settings are obscure but because each is felt on every
  device at once, or deletes history that cannot be recovered. It is a native `<details>` - the
  browser supplies the keyboard and screen-reader behaviour, and find-in-page can still reach the
  fields in browsers that expand on search.
- **Screenshot interval and quality sit with the toggle that governs them** and are disabled
  alongside it, so neither can be tuned under the impression it is doing something while captures
  are off.
- **One Save for all three groups**, pinned to the bottom of the viewport, with an "Unsaved changes"
  marker. The form is taller than a screen and one group is collapsed, so a button that scrolled
  away with the first card would strand changes made in the last one.
- Input bounds are mirrored from the backend's Zod schema so a bad value is caught at the input
  rather than as a 400 after a round trip. The server remains the enforcement point; a change there
  must be made here too, or a stricter server bound shows up as an unexplained save failure.
