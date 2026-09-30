# Session and authentication

One rule shapes this entire tier:

> **The browser never holds the session token.**

It lives in an httpOnly cookie so that a script on the page cannot read it - which is exactly the
XSS exposure that browser-readable storage leaves open. Everything below is a consequence.

---

## 1. Login

```
LoginForm (client)
   -> POST /api/auth/login                Frontend/src/app/api/auth/login/route.ts
      -> POST /v1/dashboard/auth/login    Express + Better Auth
      <- session token
   -> Set-Cookie: session=<token>; HttpOnly
```

The proxy exists solely to set that cookie. The browser never sees the token value.

Password recovery is linked from the login form (`/forgot-password`). It posts to
`/api/auth/forgot-password` and `/api/auth/reset-password`, which forward to the Express API.
The backend emails a reset link through EmailJS; no secret is ever
returned to the browser. A link lands on `/reset-password`, which redirects to `/forgot-password`;
the form captures the token and removes it from the address bar. See
[../backend/password-recovery.md](../backend/password-recovery.md). Organization registration is **not** linked from the dashboard; operators open
`/ems/advanced/register-organization` directly. That page posts to
`/api/auth/register-organization` and displays the enrollment token once.

## 2. Resolving the current user

`getSessionUser()` in `Frontend/src/lib/session.ts` asks the API rather than decoding the token.

The Better Auth session token is an **opaque identifier, not a JWT** - there are no claims in it
to read. That is a feature: role comes from the server on every request, so revoking a session or
demoting a user takes effect immediately rather than when a cached token expires.

```
cookie present? --no--> null              (genuinely signed out)
      |yes
   GET /v1/dashboard/auth/me
      |
   5xx  -> throw ApiUnavailableError       (says nothing about the session)
   401  -> null                            (session over, or account deactivated)
   2xx  -> SessionUser
```

**The distinction between the 5xx branch and the 401 branch is load-bearing.** See
[resilience.md](resilience.md) - collapsing them once signed out every open dashboard in the
building on an API restart.

## 3. Route protection

Two layers, and they check different things:

| Layer | Checks | Location |
|---|---|---|
| Middleware | That a session cookie **exists** | `Frontend/src/proxy.ts` |
| Dashboard layout | That the session is **valid** | `Frontend/src/app/(dashboard)/layout.tsx` |

The middleware is a cheap gate that keeps unauthenticated requests off protected routes without a
round trip. An expired or revoked session is caught in the layout, where `getSessionUser()`
returns `null` and the layout redirects to `/login`.

Role is resolved once in the layout and passed down as a prop. `ADMIN_ONLY_PATHS` and
`canViewScreenshots()` in `lib/session.ts` **mirror** the backend's own RBAC - they hide UI that
would 403 on arrival. They are not the enforcement; the backend is. Both must be updated together
or the dashboard offers links that fail.

## 4. Why there are four server routes and not more

A client component cannot read the httpOnly cookie, so anything a client component must fetch goes
through a same-origin route handler that attaches the credential server-side.

### `api/logs/[feed]` - the allowlist matters

Scroll windows page on the client. The feed is resolved through an **explicit map**, never by
interpolating the path segment into a URL:

```ts
const FEEDS = {
  activity:    ...  // requires employeeId
  alerts:      ...
  usb:         ...
  screenshots: ...  // index only, never image bytes
}
```

A catch-all proxy would turn this route into an open door onto every API endpoint, reachable by
anyone who can guess a path. The allowlist is what keeps it a paging endpoint.

Query parameters are also allowlisted (`cursor`, `limit`, `startDate`, `endDate`,
`includeResolved`); anything else is dropped rather than forwarded.

Feed names here must stay in step with `LogFeedName` in `lib/use-log-feed.ts`.

### `api/realtime/ticket` - why not the session token

Socket.IO's handshake auth is a payload the browser must construct, so the token would have to be
readable by page scripts - defeating the httpOnly cookie.

Instead this handler reads the cookie server-side and asks the API to mint a **short-lived signed
ticket** scoped to socket use only. The browser holds the ticket, never the session.

### `api/screenshots/[deviceId]/[file]` - why not point `<img>` at the API

An `<img src>` cannot carry an `Authorization` header, and the session cookie would not be sent
cross-origin. So the tag points at this same-origin route, which fetches the bytes server-side
with the credential attached and streams them back.

It also means **every screenshot view is audited individually**, which is why the image has its own
route rather than being served from the index.

### `api/auth/logout`

Clears the cookie and ends the session server-side.

## 5. Rules that follow

- **`lib/api-client.ts` must never be imported by a client component.** It reads `cookies()`, which
  only exists on the server. An accidental import is a build error, but the reason it is a rule is
  that the fix must not be "send the token to the browser".
- **Mutations use server actions**, not client fetches, for the same reason - see
  `app/(dashboard)/*/actions.ts`.
- **Adding a client-side data need means adding a proxy route**, with its own allowlist. It does
  not mean relaxing the cookie rule.

---

## Failure modes

| Symptom | Likely cause | Check |
|---|---|---|
| Signed out on every API restart | The 5xx / 401 distinction collapsed somewhere | `getSessionUser()` must throw, not return null, on 5xx |
| Redirect loop on `/login` | Cookie set but `/auth/me` rejects it | Cookie domain/path, and `FRONTEND_URL` in the backend's CORS config |
| Socket never connects, pages work | Ticket route failing, or `NEXT_PUBLIC_MONITORING_API_URL` unreachable from the browser | Browser console; the two API URL variables are different on purpose |
| Screenshots 404 in the browser but exist on disk | Multiple backend replicas with local screenshot storage | [../operations/backend-deployment.md](../operations/backend-deployment.md) section 3 |
| A nav link 403s on arrival | UI role mirror out of step with backend RBAC | `lib/session.ts` vs `requireRole` in the route |
| `/api/logs/<something>` returns 404 | Feed not in the allowlist | Working as designed - add it deliberately |

---

## Related

- [resilience.md](resilience.md) - what happens when `/auth/me` cannot be reached
- [live-updates.md](live-updates.md) - what the ticket is used for
- [../backend/security.md](../backend/security.md) - the enforcement side
- [../architecture/decisions.md](../architecture/decisions.md) - AD-10
