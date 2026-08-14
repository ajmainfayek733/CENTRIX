> **ARCHIVED - NOT AUTHORITATIVE.** This document describes an abandoned version of the
> agent. It is kept for history only. Do not build on it.
> The live documentation index is [../../README.md](../../README.md); see
> [../../archive/README.md](../../archive/README.md) for what superseded this file.

---

# Project Brief: Windows Employee Monitoring Agent - Claude Code Build Instructions

## Scope (read carefully)
Build **only** the Windows client software (the "Agent") that runs on employee machines and
collects the data described in the module docs. Do **not** build a backend/API, a database
server, or any dashboard/frontend - those will be built separately by another developer.

Your two deliverables are:
1. **The Windows Agent application** (.NET 10) - fully functional, production-quality.
2. **A standalone Backend API Specification document** detailed enough that a backend
   developer who has never seen this codebase can implement the server independently, in
   whatever stack they choose, and have it work correctly with the Agent on the first try.

Do not implement any backend code, mock server, or dashboard UI. Where the Agent needs to
call a backend, build it against the interface defined in the spec (e.g. behind an
`IBackendClient` abstraction) so it's ready to point at the real backend once built.

## Step 0 - Required reading before any code
Read the full project context in this order and summarize your understanding back to me:

1. `D:/Windows software/Rules.md` - global rules and constraints that apply to every module.
2. `D:/Windows software/Modules/1. Attemdace.md`
3. `D:/Windows software/Modules/2. Active app session.md`
4. `D:/Windows software/Modules/3. Active vs idle.md`
5. `D:/Windows software/Modules/4. Browser monitor.md`
6. `D:/Windows software/Modules/5. screen shot.md`
7. `D:/Windows software/Modules/6. USB logs.md`
8. `D:/Windows software/Modules/7. Alert.md`

After reading, produce:
- A one-paragraph summary of each module's purpose and the data it captures.
- A list of every open question, contradiction, or missing requirement across the docs
  (e.g. undefined thresholds, unclear data retention periods, unspecified alert channels,
  how/when data should sync to the backend). Ask me these before proceeding - do not guess
  at business logic.

## Step 1 - Client architecture proposal (wait for my approval before coding)
Propose, and wait for me to confirm:

- **Process model**: e.g. a Windows Service or background/tray app that starts on login,
  runs invisibly, and is resilient to crashes/restarts.
- **Tech stack**: .NET 10, C#, minimal local UI if any (e.g. system tray icon + settings
  panel only - no employee-facing dashboard needed), local storage for offline buffering
  (SQLite is a reasonable default) before data is synced to the backend.
- **Solution structure**, e.g.: `Agent.Core` (domain logic per module), `Agent.Collectors`
  (attendance, app session, idle detection, browser monitor, screenshot, USB), `Agent.Sync`
  (queues data and pushes to backend via the API contract you'll define), `Agent.Host`
  (Windows Service/tray host), `Agent.Tests`.
- **Local data & sync strategy**: how each module's data is captured, buffered locally, and
  batched/sent to the backend (real-time vs interval-based), plus retry/backoff behavior
  when the backend is unreachable.
- **Security & privacy considerations that affect the client**: local data encryption at
  rest, secure credential/token storage, and an employee-facing consent/disclosure notice.
  Many jurisdictions legally require notifying employees they're being monitored - flag this
  explicitly rather than skipping it silently; note it in both the client behavior and the
  backend spec (e.g. a consent-acknowledged flag sent to the server).

Do not write implementation code until I confirm this plan.

## Step 2 - Build process (once the plan is approved)
- Implement one module at a time (order above), following `Rules.md` for every module.
- For each module: domain models -> collection/business logic -> local persistence -> sync
  interface -> unit tests. Self-verify before moving to the next module.
- After each module, give me a short changelog: what was built, how to test it, and any
  deviations from spec (with reasoning).
- Use dependency injection, async/await throughout, and centralized error handling/logging
  (e.g. Serilog) - no bare try/catch blocks that swallow exceptions.
- Write unit tests for business logic (idle-detection thresholds, alert rules, attendance
  calculations, sync retry logic, etc.) as you go.
- Keep configuration (thresholds, alert rules, sync intervals, backend URL) in config files,
  never hardcoded.
- Commit to git after each completed module with a clear message, if a repo is initialized.

## Step 3 - Backend API Specification document (the second deliverable)
Produce a single, well-organized markdown document (e.g. `docs/backend-api-specification.md`)
that a backend developer can build against without needing to read the Agent's source code.
It must include:

1. **Overview** - purpose of the system, how the Agent and backend relate, high-level data
   flow diagram (described in text/ASCII).
2. **Authentication & security** - how the Agent authenticates to the backend (e.g. API key
   or JWT per device/employee), transport security (TLS), and how tokens are issued/rotated.
3. **Sync strategy the backend must support** - expected call frequency/batch sizes per
   module, idempotency requirements (so retries don't duplicate data), and how the backend
   should acknowledge receipt.
4. **Endpoint-by-endpoint contract**, one section per module (Attendance, App Sessions,
   Active/Idle, Browser Monitor, Screenshots, USB Logs, Alerts). For each endpoint specify:
   - HTTP method + path
   - Purpose
   - Request payload schema (field names, types, required/optional, units, examples)
   - Response payload schema and status codes
   - Error cases and expected error response format
   - A sample request and sample response
5. **Shared/common data models** - e.g. Employee/Device identity fields, timestamp
   conventions (UTC, ISO 8601), pagination conventions if the backend exposes any read
   endpoints.
6. **Screenshot/binary data handling** - since screenshots are large payloads, specify the
   expected upload mechanism (e.g. multipart upload vs. pre-signed URL pattern) and metadata
   that must accompany each image (timestamp, employee/device id, session id).
7. **Non-functional requirements** - expected data volume/scale, suggested indexing/retention
   guidance (advisory only, backend dev owns final DB design), logging/audit expectations,
   and API versioning approach.
8. **Consent/compliance fields** - any fields the backend must store to prove employees were
   notified/consented, if applicable per Step 1's flag.
9. **Open questions for the backend developer** - anything ambiguous in the module docs that
   affects backend design and should be confirmed with the product owner before implementation.

This document is a first-class deliverable - treat it with the same rigor as the code itself.

## Ground rules
- Prioritize correctness and maintainability over speed - this is enterprise software.
- Do not build backend code, a database server, or dashboard/frontend UI under any
  circumstance in this project - that is explicitly out of scope.
- If a module doc conflicts with `Rules.md`, ask me rather than resolving it silently.
- If a requirement is ambiguous, propose a sensible default, state the assumption, and keep
  moving - but always surface anything with legal or privacy weight instead of assuming it
  away.
