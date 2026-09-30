# System overview

Three tiers, three processes, three trust levels. They are separate because each one can do
something the others cannot, and because a compromise of one must not hand over the others.

```
   WORKSTATION (x30-100)                 SERVER                        OPERATOR
 +------------------------+     +----------------------+     +----------------------+
 |  Centrix       |     |  Backend/            |     |  Frontend/           |
 |  .Service.exe          |     |  Express + Prisma    |     |  Next.js App Router  |
 |  (LocalSystem, sess 0) |     |  PostgreSQL          |     |                      |
 |     |  named pipe      |---->|                      |<----|                      |
 |     v                  | HTTP|  /api/v1/*  (agents) |HTTP |  server components   |
 |  Centrix       |<----|  /v1/dashboard/*     |---->|  + proxy routes      |
 |  .Host.exe             | Sock|                      |Sock |                      |
 |  (user session, WPF)   |<--->|  Socket.IO           |<--->|  browser             |
 +------------------------+     +----------------------+     +----------------------+
        collects                    stores and decides            reads and administers
```

Detailed docs: [agent/architecture.md](../agent/architecture.md),
[backend/README.md](../backend/README.md), [frontend/README.md](../frontend/README.md).

---

## 1. Why the agent is two processes

Session 0 - where Windows services run - has no desktop. A service **cannot** read a foreground
window title, measure user idle time, or capture the screen. Those collectors must live in the
interactive user session.

But a user-session process cannot start before logon, does not survive logoff, and runs as a
standard user who must not be able to read the device credential or the collected data.

So the responsibilities split by capability:

| | `Centrix.Service.exe` | `Centrix.Host.exe` |
|---|---|---|
| Runs as | LocalSystem, session 0 | The logged-on user, interactive session |
| Starts | At boot, before anyone logs on | At logon, launched by the service |
| Owns | SQLite store, device API key, policy, all backend traffic | Nothing durable except screenshot JPEGs |
| Does | Decides and persists | Observes and reports |
| Network | Yes - the only process that talks to the backend | None |

The host holds no credential and opens no socket. If it is killed, the service restarts it
with crash-loop backoff and no data is lost, because everything the host observed was already
handed over the pipe. See [agent/architecture.md](../agent/architecture.md) section 2.

## 2. Why the backend serves two distinct surfaces

The same Express process answers two audiences that must never share an authentication path.

| | Write path | Read path |
|---|---|---|
| Caller | Windows agent, unattended | A signed-in human |
| Prefix | `/api/v1/*` | `/v1/dashboard/*` |
| Credential | Per-device API key (bearer) | Better Auth session |
| Middleware | `deviceAuth` | `userAuth` + `requireRole` |
| Frequency | Every ~2 min per device | On page load and filter change |
| Volume | 30-100 devices x 6 channels | A handful of operators |

**The prefixes are the safety property.** A stolen device key must not read anyone's reports,
and a stolen dashboard session must not be able to inject fabricated activity. Because the two
never share middleware, that separation is structural rather than a matter of remembering to
check a flag.

Source: `Backend/src/server.ts` mounts both; `Backend/src/middleware/deviceAuth.ts` and
`Backend/src/middleware/userAuth.ts` are the two gates. Details in
[backend/security.md](../backend/security.md).

## 3. Why the dashboard has server-side routes at all

The Next.js tier owns no data. It has no database connection and no Prisma schema - every value
on screen came from the Express API.

Its server side exists for exactly two reasons:

1. **Server-rendering the first paint**, which is also what lets the session token stay in an
   httpOnly cookie instead of browser-readable storage.
2. **Proxying** the few requests a client component must make. A client component cannot read
   the httpOnly cookie, so it calls a same-origin route handler that attaches the credential
   server-side.

There are four such proxies and no more. Each is narrow on purpose:

| Route | Exists because |
|---|---|
| `Frontend/src/app/api/auth/login/route.ts` | Login must set the httpOnly cookie |
| `Frontend/src/app/api/logs/[feed]/route.ts` | Scroll windows page on the client; feeds are allowlisted so this cannot become an open proxy |
| `Frontend/src/app/api/realtime/ticket/route.ts` | The browser needs a socket credential that is not the session token |
| `Frontend/src/app/api/screenshots/[deviceId]/[file]/route.ts` | An `<img>` tag cannot send an Authorization header |

Details in [frontend/session-and-auth.md](../frontend/session-and-auth.md).

## 4. Two channels, two jobs

The agent and the dashboard both hold a Socket.IO connection **and** use HTTP. They are not
alternatives.

| | HTTP | Socket.IO |
|---|---|---|
| Carries | Telemetry, policy, reports | Signals: "something changed", "sync now", presence |
| Guarantees | Durable, acknowledged, idempotent | Best effort |
| If it fails | The data is retried until accepted | A screen is stale until its next refresh |
| Is the system of record | Yes | Never |

**A live socket proves nothing about availability.** It survives an unplugged cable for minutes
and says nothing about whether the server can reach Postgres. The agent's availability oracle is
`GET /api/v1/heartbeat`; a load balancer's is `GET /health`, which runs a real query rather than
returning a constant (`Backend/src/server.ts`). Turning `realtimeEnabled` off in policy falls
the whole fleet back to poll-only behaviour with no redeploy and no data loss.

Details in [backend/realtime.md](../backend/realtime.md).

## 5. Scale this was built for

30 devices, designed to hold to 100+, typically **all behind one office IP**. That single fact
drives several decisions that look odd otherwise:

- Rate limits are keyed per **device**, not per IP - a hundred workstations behind one NAT would
  otherwise share one budget. See [backend/security.md](../backend/security.md) section 4.
- Enrollment is keyed on **MachineGuid** from the request body for the same reason.
- Socket.IO runs **single-process with no Redis adapter**. One Node process holds 100 sockets
  comfortably. A second replica would need the adapter; that is a deployment change.
- Screenshots are on the **local filesystem**, which is the thing that actually blocks
  horizontal scaling. See [operations/backend-deployment.md](../operations/backend-deployment.md)
  section 3.

## 6. Rules that hold everywhere

- **No JSON columns.** Not in PostgreSQL, not in the agent's SQLite. Every telemetry field has
  its own typed column. JSON exists as a transport encoding for HTTP bodies and IPC frames; it
  is never a storage format. A malformed value therefore fails at collection time instead of
  becoming an unqueryable blob.
- **No keystroke content anywhere in the pipeline.** Not as a C# field, not as a SQLite column,
  not as a Zod schema field, not as a Postgres column. The keyboard hook increments a counter and
  returns without dereferencing the event.
- **Delete local copies only after the server acknowledges them**, by id, never by batch status.
- **Timestamps are UTC on the wire and in storage.** The one exception is `workDate`, which is
  the employee's local calendar date, because a fleet spanning timezones would otherwise have
  days that begin at the server's midnight.

---

## Related

- [telemetry-pipeline.md](telemetry-pipeline.md) - the same system followed one event at a time
- [cross-tier-contracts.md](cross-tier-contracts.md) - what breaks if you change one side only
- [decisions.md](decisions.md) - why these choices are locked
- [../operations/troubleshooting.md](../operations/troubleshooting.md) - when the above is not happening
