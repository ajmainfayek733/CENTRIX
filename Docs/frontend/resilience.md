# Behaviour when the monitoring service is unavailable

This exists because of a real bug, and the shape of the fix is worth understanding before
touching any of it.

**The bug:** `getSessionUser()` caught *every* failure and returned `null`. The dashboard layout
reads `null` as "logged out" and redirects to `/login`. So an API restart signed out every open
dashboard in the building and sent everyone to a page that could not log them back in either -
an infrastructure outage presented as a credentials problem, with the actual cause nowhere on
screen.

---

## 1. Two errors that must never be confused

`Frontend/src/lib/api-client.ts`:

| Error | Raised for | Means | Correct response |
|---|---|---|---|
| `ApiError` | 4xx | Your request was bad, or your session is over | 401 -> `/login` |
| `ApiUnavailableError` | 5xx, connection refused, DNS failure, timeout | The service cannot answer right now | Say so; keep the session |

`fetch` rejects only for transport-level failures - an HTTP error status resolves normally and is
classified by status. Both paths funnel into the same taxonomy so callers never have to know which
kind of failure occurred.

**A 5xx says nothing about the session.** Treating it as an auth failure is what produced the bug.

## 2. What each layer does

| Layer | On `ApiUnavailableError` |
|---|---|
| `getSessionUser()` | **Throws**, rather than returning `null` |
| `(dashboard)/layout.tsx` | Catches it, renders the shell with `ServiceUnavailable` - **no redirect** |
| `(dashboard)/error.tsx` | Renders the outage card for a failing screen |
| `api/logs/[feed]` | Returns **503**, not a blanket 502 |
| `use-log-feed` | Shows a recoverable message, keeps `hasMore` true so retry works |

The layout keeps the **shell**: header, theme, navigation and a way out. A degraded screen that
also strips the navigation traps whoever hits it on the one screen that is broken. Navigation is
hidden only when no role could be resolved, because a nav that cannot honour RBAC would offer
links that 403 on arrival.

## 3. Why the error boundary matches on the message

React strips server-side errors before they reach the client, replacing them with a generic
`Error` and a digest. `instanceof ApiUnavailableError` **cannot survive the boundary**.

So `(dashboard)/error.tsx` matches the error name and the message shape our own client produces,
and treats anything unrecognized as a bug. That direction is deliberate: calling a genuine bug an
outage would leave people waiting for a service to come back that was never down.

The **digest is displayed** rather than hidden. It is Next's server-side correlation id and the
only thing that ties a user's report to a specific server log line - unlike the message, which for
a server error is redacted anyway.

## 4. What the user is told

`ServiceUnavailable` does three things on purpose:

1. **Says what is actually wrong.** "Could not reach the monitoring service" points at a different
   fix than "your session expired". Presenting an outage as an auth failure sends an operator to
   re-enter a password that was never the issue.
2. **States what is still true:** *no data is being lost* - agents keep collecting and queue
   locally through an outage. That is the first question anyone looks at this page to answer, and
   leaving it unanswered invites a panicked call.
3. **Offers a retry that costs nothing.** Outages here are usually a restart or a brief blip, so
   the useful action is to try again, not to reload the whole app.

It never shows a stack trace or an internal hostname.

`ConnectionBanner` covers the milder case: the page loaded, but live updates are not flowing.

## 5. How this was verified

Not with unit tests. Against the **built** app pointed at a dead API port:

```bash
cd Frontend
npm run build
MONITORING_API_URL=http://127.0.0.1:5999 npx next start -p 3099
```

Expected behaviour:

- `/login` reports the service as unavailable instead of rejecting valid credentials.
- `/overview` renders the shell with the outage card and **does not redirect**.
- An existing session survives; the screen recovers on its own once the service responds.

`next dev` refuses to start a second server in the same directory, which is why this uses
`next start`.

**Re-run this after touching any of: `api-client.ts`, `session.ts`, the dashboard layout, the error
boundary, or the logs proxy.** Every one of them can silently reintroduce the original bug, and no
test in the suite catches it.

---

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| API restart signs everyone out | 5xx collapsed into `null` again | `getSessionUser()` must throw on 5xx |
| Outage shows as "session expired" | Error classified as `ApiError` | Check `isUnavailableStatus` |
| Real bug reported as an outage | Message matcher too broad | The matcher should be narrow; unknown = bug |
| Blank page, no chrome | Error escaped the boundary, or the layout itself threw | The layout must catch `ApiUnavailableError` only and rethrow the rest |
| Retry does nothing | `hasMore` cleared on failure | Failure must be recoverable |
| User reports an error with no server trace | Digest hidden | It must be displayed |

---

## Related

- [session-and-auth.md](session-and-auth.md) - the session resolution this protects
- [live-updates.md](live-updates.md) - the milder degradation
- [../architecture/decisions.md](../architecture/decisions.md) - AD-11
- [../operations/troubleshooting.md](../operations/troubleshooting.md) - the operator's view
