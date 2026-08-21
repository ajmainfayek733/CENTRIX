# Frontend

Next.js App Router dashboard on port 3000. Source root: `Frontend/src/`.

**It owns no data.** No database connection, no Prisma schema. Every value on screen came from
the Express API. If you find yourself writing a route handler that queries a database, you have
drifted into rebuilding the backend inside this tier.

---

## Layout

```
Frontend/src/
  app/
    layout.tsx                     root shell, theme
    error.tsx                      root error boundary
    login/                         the only unauthenticated page
    (dashboard)/                   RBAC-protected route group
      layout.tsx                   resolves the session, wraps in RealtimeProvider
      error.tsx                    dashboard error boundary
      overview/                    team-wide screen
      employees/                   roster, import, [employeeId] detail
      devices/                     inventory, assignment, activation
      alerts/                      alerts + USB feeds
      settings/                    policy and category editors (super_admin)
    api/                           server-side proxies ONLY - see session-and-auth.md
      auth/login, auth/logout
      logs/[feed]
      realtime/ticket
      screenshots/[deviceId]/[file]
  components/                      shared UI, including the resilience components
  lib/
    api-client.ts                  server-only fetch wrapper + error taxonomy
    session.ts                     getSessionUser, role helpers
    realtime.ts                    socket contract mirroring the backend
    use-log-feed.ts                keyset paging hook for every scroll window
    format.ts
  types/api.ts                     response shapes from the API
```

## Server components by default

Client components are the exception, opted into with `'use client'`. A component becomes a client
component only when it needs one of: browser state, an event handler, a socket, or scroll-driven
paging.

| Concern | Where it runs |
|---|---|
| Reading data from the API | Server component, via `apiGet` |
| The session cookie | Server only - `lib/api-client.ts` must never be imported by a client component |
| Mutations | Server actions (`actions.ts` files) |
| Paging on scroll | Client component -> `/api/logs/[feed]` proxy |
| Live presence | Client component -> socket |

The dashboard layout resolves the session **once per navigation** and passes the role down as a
prop. Client components never hold auth state of their own.

## Data flow

```
server component
   -> apiGet('/v1/dashboard/...')      Frontend/src/lib/api-client.ts
      attaches the session cookie server-side, cache: 'no-store'
   -> unwraps { data }
   -> renders

client component (scroll / socket only)
   -> fetch('/api/logs/<feed>')        same-origin proxy, allowlisted
   -> proxy calls apiGet server-side
```

`cache: 'no-store'` is not optional. Next caches `fetch` aggressively by default, and a cached
read would show a manager yesterday's "who is online now" - the one thing this dashboard exists
to answer.

## The four proxy routes

These exist because a client component cannot read the httpOnly session cookie. Each is narrow on
purpose; none is a general-purpose passthrough.

| Route | Why it exists |
|---|---|
| `api/auth/login` | Must set the httpOnly cookie |
| `api/logs/[feed]` | Scroll paging; feeds are **allowlisted** so it cannot become an open proxy |
| `api/realtime/ticket` | Mints a socket credential that is not the session token |
| `api/screenshots/[deviceId]/[file]` | An `<img>` tag cannot send an Authorization header |

Full reasoning in [session-and-auth.md](session-and-auth.md).

## Environment

| Variable | Read by | Notes |
|---|---|---|
| `MONITORING_API_URL` | Server only | May be an internal hostname the browser cannot resolve |
| `NEXT_PUBLIC_MONITORING_API_URL` | Browser | Must be reachable **from the browser** - this is the socket address |

They are separate for exactly that reason. Setting only the first leaves the socket pointed at
`http://localhost:5000` from the user's machine.

## `AGENTS.md` and `CLAUDE.md` in this tree

Both are written and re-added by `next dev` itself
(`node_modules/next/dist/server/lib/generate-agent-files.js`). They are **not** documentation and
are deliberately not moved into `Docs/`. Removing them from a diff only re-creates the
uncommitted change.

## Commands

```bash
cd Frontend
npm run dev              # http://localhost:3000
npm run build
npm start                # required to test the built app; see below
```

`next dev` refuses to start a second server in the same directory. To test against a different API
port, build and use `next start`:

```bash
MONITORING_API_URL=http://127.0.0.1:5999 npx next start -p 3099
```

That is how the degraded-mode behaviour in [resilience.md](resilience.md) was verified.

---

## Related

- [session-and-auth.md](session-and-auth.md) - the cookie rule and its consequences
- [live-updates.md](live-updates.md) - sockets and scroll windows
- [design-system.md](design-system.md) - surfaces, palette, type and the component vocabulary
- [resilience.md](resilience.md) - behaviour when the backend is down
- [spec.md](spec.md) - the original governing specification
- [../backend/reporting.md](../backend/reporting.md) - the endpoints behind these screens
- [../reference/dashboard-api.md](../reference/dashboard-api.md) - endpoint reference
