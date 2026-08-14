# Architectural decisions

Decisions that are locked, and the reasoning that locked them. If you are about to reverse one,
the entry tells you what problem you are re-opening.

Each entry: **what was decided**, **what it rules out**, **what would justify revisiting**.

---

## AD-01 - The agent is a SYSTEM service plus a user-session host

**Decided:** two executables. `EmployeeMonitor.Service.exe` runs as LocalSystem in session 0 and
owns policy, the SQLite store, the device credential, USB/WMI events and all backend traffic.
`EmployeeMonitor.Host.exe` runs in the interactive session and owns foreground-window tracking,
idle state, input counts, browser URL extraction and screenshots. They talk over a secured named
pipe; the service supervises and restarts the host.

**Rules out:** moving screen capture or window-title collection into the service. Session 0 has
no desktop - it physically cannot do either. Also rules out a host-only agent: it could not start
before logon, survive logoff, or hold a credential a standard user cannot read.

**Revisit when:** never, for the capability split. Windows session isolation is the constraint.

## AD-02 - WPF, self-contained .NET 10, untrimmed

**Decided:** the host UI is WPF, published self-contained `win-x64`, single-file, **untrimmed**.

**Rules out:** WinUI 3 - a self-contained publish drags in the Windows App SDK, which is fragile
to deploy across 30+ workstations. Also rules out trimming: it breaks `System.Management`'s
reflectively-resolved WMI types and **silently disables USB collection** rather than failing the
build.

**Revisit when:** the Windows App SDK ships in a form that deploys as a single self-contained
artifact.

## AD-03 - No JSON columns anywhere

**Decided:** every telemetry field has its own typed column, in both PostgreSQL and the agent's
SQLite. JSON is a transport encoding for HTTP bodies and IPC frames only.

**Rules out:** a `payloadJson` envelope on ingest (this existed in v2 and was removed), and any
serialized-document column in the local queue.

**Why it pays:** a malformed value becomes a 400 at the door instead of an unqueryable blob
discovered weeks later; the local queue stays inspectable with any SQL client; the policy cache is
read constantly by the service and typed columns avoid re-parsing a blob on every read.

**Revisit when:** never - this is a standing project rule, not a preference.

## AD-04 - Device identity is MachineGuid, not MAC address

**Decided:** identity is `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`. The MAC address is
collected and reported as an attribute.

**Rules out:** keying devices on MAC. It is spoofable, and a laptop with Wi-Fi, Ethernet and a
dock reports three of them.

**Consequence:** re-enrollment is idempotent on MachineGuid and preserves the employee
assignment, so a re-imaged workstation recovers with no admin action.

## AD-05 - Reports read a pre-aggregated rollup

**Decided:** dashboard reports read `daily_activity_rollups`. They never scan `activity_sessions`
to aggregate on the fly. Counters are **incremented** inside the ingest transaction, never
recomputed.

**Rules out:** ad-hoc aggregation over raw telemetry in the read path. That query degraded with
**history** rather than headcount, so it got worse forever and could not be fixed by adding
capacity.

**Consequence:** exactly-once accounting becomes mandatory. Every ingest prepare step filters
against already-stored ids and counts only genuinely inserted events - see
[../backend/ingest.md](../backend/ingest.md).

## AD-06 - Log feeds are keyset-paginated, never OFFSET

**Decided:** cursor = `(timestamp, id)`, newest first, page over-fetches by one row to answer
`hasMore` without a second `COUNT`.

**Rules out:** `OFFSET`. Its cost grows with how far the operator has scrolled - backwards for a
log whose interesting rows are at the end - and it repeats or skips rows under a live feed.

**Why the id is in the key:** timestamps collide. An agent can close several app sessions in the
same millisecond, and a cursor on a non-unique key either loses the tied rows or repeats them
forever.

## AD-07 - Socket.IO is signalling only

**Decided:** the socket carries "something changed", presence, and force-sync commands. It never
carries telemetry, and neither side treats an open connection as proof the backend is available.

**Rules out:** pushing rows to dashboards, and using socket state as a health check. A socket
survives an unplugged cable for minutes and says nothing about whether the server can reach
Postgres.

**Consequence:** `realtimeEnabled` can be switched off in policy to fall the fleet back to
poll-only behaviour with no redeploy and no data loss.

## AD-08 - Single Node process, no Redis adapter

**Decided:** one process holds every socket. Rate-limit counters live in process memory.

**Rules out:** running multiple `api` replicas without further work. Each would enforce its own
rate-limit budget, so the effective limit multiplies by the replica count, and Socket.IO rooms
would not span processes.

**Revisit when:** the fleet outgrows one process, or the deployment needs redundancy. Adding the
Redis adapter and a shared limiter store are the two changes; the emit helpers in
`Backend/src/realtime/index.ts` are the only places that would care.

## AD-09 - Rate limits are keyed per device, not per IP

**Decided:** enrollment is keyed on the MachineGuid in the request body; authenticated agent
traffic is keyed on the device row id. A generous per-IP backstop sits in front of authentication.

**Rules out:** per-IP limiting as the primary control. An office of 100 machines shares one public
address - keyed by IP, the enrollment limit of 10/min would have applied to the entire company.

## AD-10 - The browser never holds the session token

**Decided:** the session lives in an httpOnly cookie. Client components that need data call a
same-origin Next.js route handler that attaches the credential server-side. The socket uses a
short-lived signed **ticket** minted from the cookie, not the session token.

**Rules out:** `localStorage` sessions, client-side `fetch` to the API with an Authorization
header, and passing the session token into the socket handshake from the browser.

**Consequence:** four proxy route handlers exist. Each is narrow on purpose; the log-feed proxy
uses an explicit feed allowlist so it cannot become an open door onto every API endpoint.

## AD-11 - "Unreachable" and "unauthorised" are different errors

**Decided:** `ApiUnavailableError` is distinct from `ApiError`. A 5xx or a transport failure never
produces a redirect to `/login`.

**Rules out:** the previous behaviour, where `getSessionUser()` caught every failure and returned
`null`, which the layout read as "logged out". An API restart signed out every open dashboard in
the building and sent everyone to a page that could not log them back in either - an
infrastructure outage presented as a credentials problem.

**Verified against:** a dead API port, with the built app (`next start`), not just unit tests.

## AD-12 - Screenshots are excluded from the Auditor role

**Decided:** `super_admin` and `manager` may view screenshots. `auditor` may not - not the index,
not the image. Every view is written to the audit log individually.

**Rules out:** treating screenshots as just another report. They are the most invasive surface in
the product; an auditor gets aggregates and the audit log, never a picture of someone's desktop.

## AD-13 - Screenshots have their own page size

**Decided:** `screenshotPageSize` (default 12) is separate from `logPageSize` (default 50), with a
lower hard ceiling (60 vs 500).

**Rules out:** sharing one page-size setting. A page of log rows is a few kilobytes of JSON; a
page of screenshots is that many full-size JPEGs the browser actually downloads and decodes. At
~500 KB a capture, a 50-item page is ~25 MB of image traffic for one flick of the scroll wheel.

## AD-14 - WiX pinned to 5.0.2

**Decided:** the installer toolchain is WiX 5.0.2, with `Util`, `UI` and `Firewall` extensions
version-matched.

**Rules out:** WiX v6+, which requires accepting the paid Open Source Maintenance Fee EULA and
fails with `WIX7015` without it. Extensions not matching the CLI version fail with `WIX6101`.

**Revisit when:** the licensing position changes. Do not upgrade incidentally.

## AD-15 - The installer does not write the agent's configuration

**Decided:** the MSI shells out to `EmployeeMonitor.Service.exe --configure` from a deferred custom
action. The agent creates its own ProgramData layout, applies the ACLs and writes
`agent.config.json`; `Deploy-Agent.ps1` calls the same entry point.

**Rules out:** authoring the JSON as an MSI file and the ACLs as `util:PermissionEx`. That would be
a second definition of a layout the service depends on at runtime, in a language that cannot be
tested, free to drift from the code that reads it - and it already had: the PowerShell version
resolved identities by name (`BUILTIN\Users`), so it threw on a localized Windows.

**Costs:** an install failure surfaces as a custom action exit code in the MSI log rather than as a
typed MSI error. `Return="check"` makes it roll the transaction back, so the failure is at least
never silent.

**Revisit when:** the configuration grows beyond what a command line can carry.

---

## Related

- [system-overview.md](system-overview.md) - the shape these decisions produced
- [cross-tier-contracts.md](cross-tier-contracts.md) - what they cost when changing things
- [../operations/troubleshooting.md](../operations/troubleshooting.md) - the failures they prevent
