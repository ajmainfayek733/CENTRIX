# AGENTS.md — Monitoring Dashboard (Next.js)

Governing spec for the dashboard repo, App Router edition. Read before writing code
in any folder below. This repo is the **read path only** — it never talks to agents,
never handles device tokens, and every request it makes carries a manager/HR user's
session. If you find yourself adding device-token logic here, stop — that belongs in
`monitoring-server`, not this repo.

---

## 1. Scope and stack reality-check

- **Next.js App Router**, not Pages Router — routes live under `app/`, layouts and
  server components are the default, client components are the exception (opted into
  with `'use client'`).
- This dashboard is a **client of `monitoring-server`**, not a full-stack app in its
  own right. It has no database connection of its own and no Prisma schema — every
  piece of data comes from the Express API. Next.js's server-side capabilities here
  are used for two things only: server-rendering the initial page (faster first
  paint, and it lets you keep the session token in an httpOnly cookie instead of
  browser-readable storage — see §3) and proxying auth.
- **Do not** reach for Next.js API routes to reimplement business logic that already
  exists in `monitoring-server`. If you find yourself writing a route handler that
  queries a database, you've drifted into rebuilding the backend inside the frontend
  repo — the only backend-shaped code that belongs here is the thin auth proxy in §3.

---

## 2. Folder structure

Frontend/
├── src/
│ ├── app/
│ │ ├── layout.tsx
│ │ ├── page.tsx # landing/redirect
│ │ ├── login/
│ │ │ └── page.tsx
│ │ ├── (dashboard)/ # route group, RBAC-protected
│ │ │ ├── layout.tsx # session check + role gate
│ │ │ ├── overview/
│ │ │ │ └── page.tsx
│ │ │ ├── employees/
│ │ │ │ ├── page.tsx # roster list
│ │ │ │ └── [employeeId]/
│ │ │ │ └── page.tsx # detail/timeline
│ │ │ ├── reports/
│ │ │ │ └── page.tsx
│ │ │ └── settings/
│ │ │ ├── categories/page.tsx
│ │ │ ├── retention/page.tsx
│ │ │ └── users/page.tsx
│ │ └── api/ # thin BFF proxy only (optional)
│ │ └── auth/[...nextauth]/route.ts # if using NextAuth
│ ├── components/ # shared, presentational only
│ │ ├── ui/
│ │ │ ├── Table.tsx
│ │ │ ├── Chart.tsx
│ │ │ └── Card.tsx
│ │ └── guards/RoleGuard.tsx
│ ├── features/ # feature-scoped components/hooks
│ │ ├── overview/TeamSummaryCard.tsx
│ │ ├── employees/
│ │ │ ├── ActivityTimeline.tsx
│ │ │ └── useEmployeeData.ts
│ │ ├── reports/ExportButton.tsx
│ │ └── settings/CategoryRuleForm.tsx
│ ├── lib/
│ │ ├── api-client.ts # typed fetch wrapper → Backend REST API
│ │ ├── auth.ts # session/JWT helpers
│ │ └── constants.ts
│ ├── store/ # Zustand/RTK client state
│ │ ├── auth.slice.ts
│ │ ├── employees.slice.ts
│ │ └── settings.slice.ts
│ ├── types/ # or import from shared/contracts
│ └── middleware.ts # Next.js middleware — auth/RBAC redirects
├── public/
├── next.config.js
├── tsconfig.json
└── tests/
├── employees.test.tsx
└── activity-timeline.test.tsx

---

## 3. Auth: httpOnly cookie, not localStorage

This is the one meaningful change from a Vite/SPA setup, and it's a real security
improvement worth keeping:

1. `app/api/auth/login/route.ts` receives the login form submission, calls
   `monitoring-server`'s `/v1/dashboard/auth/login`, and on success sets the JWT it
   gets back as an **httpOnly, secure, sameSite=lax cookie** — never exposed to
   client-side JS. This closes the XSS-can-steal-the-token gap the Vite version
   explicitly accepted as a tradeoff.
2. `middleware.ts` runs on every request to a protected route, reads the cookie,
   verifies it (or does a lightweight decode + expiry check — full verification can
   stay server-side per-request), and redirects to `/login` if missing/invalid.
3. **Server components** read the cookie via `cookies()` from `next/headers` and
   attach it as the `Authorization` header when calling `monitoring-server` — this
   happens server-side, so the token never touches the browser as a JS-readable
   value at all.
4. **Client components** (interactive filters, buttons) never need the token
   directly — they call a Next.js route handler (`app/api/...`) or a server action,
   which reads the cookie server-side and forwards the request. A client component
   should never construct an `Authorization` header itself.

```typescript
// lib/api-client.ts — server-side only
import { cookies } from "next/headers";

export async function serverFetch(path: string, init?: RequestInit) {
  const token = (await cookies()).get("session")?.value;
  return fetch(`${process.env.MONITORING_API_URL}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    cache: "no-store", // activity data is live; don't let Next cache it silently
  });
}
```

**`cache: 'no-store'` is not optional here.** Next.js aggressively caches `fetch` by
default; an uncached team-summary report is the whole point of this dashboard, and a
stale cached read would show a manager yesterday's "who's online now."

---

## 4. Data fetching pattern

- **Server components** (default) fetch on the server for the initial page load —
  the Overview screen, Employee list, and Employee detail's initial timeline all load
  this way. This is where Next.js earns its keep over the Vite version: no client-side
  loading spinner on first paint, and the auth token never leaves the server.
- **Client components** handle anything interactive after that: date-range pickers,
  "refresh now," live filters. These call route handlers under `app/api/dashboard/*`
  (thin proxies to `monitoring-server`, reusing `serverFetch`) via
  `@tanstack/react-query` — same reasoning as the Vite version: consistent
  loading/error state across screens without hand-rolling it per component.
- **Rule of thumb**: if the data is needed to render the page at all, fetch it in the
  server component. If it only changes in response to a user action after the page is
  interactive, fetch it client-side through a route handler.

---

## 5. middleware.ts — route + RBAC gate

```typescript
export function middleware(request: NextRequest) {
  const session = request.cookies.get("session")?.value;
  const { pathname } = request.nextUrl;

  if (!session && pathname.startsWith("/(dashboard)")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const role = decodeRole(session); // lightweight decode, not full verify
  if (pathname.startsWith("/settings") && role !== "super_admin") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = { matcher: ["/((?!login|_next/static|_next/image).*)"] };
```

As with the Vite version: **this is UX, not the security boundary.** `monitoring-server`
re-checks RBAC on every request regardless (per that repo's `AGENTS.md` §4) — this
middleware only prevents a manager from seeing a settings page that would 403 anyway.

---

## 6. components/ — same organization as before, framework-adjusted

- `dashboard/` — Overview screen widgets (server components by default).
- `employee-detail/` — timeline, app/site breakdown; the date-range picker inside it
  is a client component, the initial data table is a server component.
- `reports/` — filterable views; export buttons stay disabled/hidden until the
  backend endpoint exists (Phase 2, same as before).
- `ui/` — shadcn components, installed via the shadcn CLI, not hand-copied — keeps
  them updatable.

**Rule carried over unchanged**: no component fetches `monitoring-server` directly
with a raw `fetch`/`axios` call. Server components use `lib/api-client.ts`; client
components use a hook that calls a local route handler.

---

## 7. hooks/ — client-side only now

Since server components handle the initial load, hooks here are strictly for
post-load, client-side interactivity:

| Hook                           | Wraps                                                           | Notes                                                           |
| ------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `useTeamSummaryRefresh.ts`     | `GET /api/dashboard/reports/team-summary` (local route handler) | Powers a manual refresh / polling toggle on the Overview screen |
| `useEmployeeTimelineFilter.ts` | `GET /api/dashboard/employees/:id/timeline`                     | Re-fetches when the date range changes                          |
| `useAuditLog.ts`               | `GET /api/dashboard/audit-log`                                  | Auditor + super_admin only                                      |

There is no `useAuth.ts` client hook anymore — auth state lives in the httpOnly
cookie and is read server-side; a client component that needs to know the current
role reads it from a server component prop (passed down from the layout, which
decoded it server-side), not from client-side state.

---

## 8. types/ — unchanged in purpose

Still mirrors `monitoring-server`'s DTOs field-for-field (see that repo's `AGENTS.md`
§7). Same warning as before: a drifted type here doesn't fail the build, it silently
renders `undefined` in a report. Treat contract changes as a two-repo commit.

---

## 9. Phase mapping (month-1 MVP)

| Component                                               | Priority              | Month-1?                                                                                     |
| ------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| Login route + httpOnly cookie + `middleware.ts` gate    | M                     | **Yes**                                                                                      |
| Overview screen (server component)                      | M                     | **Yes**                                                                                      |
| Employee list (server component)                        | M                     | **Yes**                                                                                      |
| Employee detail — timeline, active/idle split           | M                     | **Yes**                                                                                      |
| RBAC gating (Admin + Manager only)                      | M                     | **Yes** — Auditor can wait                                                                   |
| Date-range filtering (client component + route handler) | M                     | **Yes**, basic ranges                                                                        |
| CSV/PDF export buttons                                  | S                     | Defer — hide, don't ship broken                                                              |
| Screenshot viewer                                       | S                     | Defer                                                                                        |
| Auditor-specific views                                  | S                     | Defer                                                                                        |
| Settings screen                                         | M (per original spec) | Partial — categories only if time allows; retention/work-hours can defer to direct DB config |

---

## 10. Definition of done (month-1 MVP)

- A manager can log in; the session cookie is httpOnly and never appears in
  browser-accessible storage or client bundle.
- Initial page loads (Overview, Employee list, Employee detail) render server-side
  with real data — no client-side spinner on first paint.
- `middleware.ts` blocks unauthenticated access to every `(dashboard)` route and
  blocks non-admins from `/settings`.
- No `fetch`/`axios` call to `monitoring-server` happens directly from a client
  component; every client-side data need goes through a local route handler.
- Report data is never served from Next.js's fetch cache — every load reflects the
  current state in Postgres.
