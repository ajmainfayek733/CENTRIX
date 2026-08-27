# Employee Monitor - v3

Windows-native monitoring agent, Express/Postgres backend, and Next.js admin dashboard.

This directory holds the **agent**. The other two tiers live in `Backend/` and `Frontend/` at
the repository root.

> Earlier attempts in `Agent/` and `Windows Software/` are abandoned. Nothing here depends on
> them.

---

## Architecture

```
Windows boot
  +- EmployeeMonitor.Service      (LocalSystem, session 0)
       +- policy fetch + heartbeat            ConnectivityWorker
       +- backend sync (offline queue drain)  SyncWorker
       +- USB / WMI device events             UsbWorker
       +- retention sweep                     RetentionWorker
       +- SQLite store + offline queue        Agent.Core.Storage
       +- named pipe  -------------+          IpcServer
                                   |
User logon                         |
  +- EmployeeMonitor.Host  --------+          (interactive session)
       +- foreground window / activity sessions
       +- idle + active state
       +- key and mouse *counts* (never content)
       +- browser URL via UI Automation
       +- screenshots (policy-gated)
       +- WPF disclosure window + tray indicator
```

**Why two processes.** Session 0 cannot read a foreground window title, cannot measure user
idle time, and cannot capture the screen. Those collectors _must_ run in the user's session. A
SYSTEM service on top gives boot-time start, survival across logoff, supervision with
crash-loop backoff, and a place to hold the device credential that a standard user cannot read.

The service starts the host with `WTSQueryUserToken` -> `DuplicateTokenEx` ->
`CreateProcessAsUser` on `winsta0\default` (see `Agent.Service/Interop/SessionLauncher.cs`).

---

## Privacy guarantees

These are architectural, not configuration:

- **No keystroke content.** `InputCounter` installs a low-level keyboard hook but only
  increments a counter - it never dereferences `lParam` or decodes a virtual key code, and no
  type anywhere in the pipeline has a field that could hold a typed character.
- **No USB contents.** Only connection and removal metadata is recorded.
- **Not hidden.** The agent runs under its own name, appears in Task Manager and Installed
  Programs, and shows a permanent tray indicator plus a window listing exactly what is and is
  not collected.
- **Consent is recorded** per policy version, and a policy change re-prompts.

---

## Projects

| Project         | Output                        | Role                                                          |
| --------------- | ----------------------------- | ------------------------------------------------------------- |
| `Agent.Core`    | library                       | Wire contracts, typed SQLite store, policy model, IPC framing |
| `Agent.Service` | `EmployeeMonitor.Service.exe` | LocalSystem service                                           |
| `Agent.Host`    | `EmployeeMonitor.Host.exe`    | WPF app in the user session                                   |

---

## Documentation

All documentation now lives in the repository's central `Docs/` tree.

| Document                                                                         | Contents                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [../Docs/agent/architecture.md](../Docs/agent/architecture.md)                   | Architecture, process model, data flow, invariants - **start here** |
| [../Docs/agent/agent-core.md](../Docs/agent/agent-core.md)                       | Every type in the shared library                                    |
| [../Docs/agent/agent-service.md](../Docs/agent/agent-service.md)                 | Every type in the service                                           |
| [../Docs/agent/agent-host.md](../Docs/agent/agent-host.md)                       | Every type in the user-session host                                 |
| [../Docs/agent/features.md](../Docs/agent/features.md)                           | Feature requirements this agent implements                          |
| [../Docs/operations/agent-deployment.md](../Docs/operations/agent-deployment.md) | Installing, updating and removing it                                |
| [../Docs/README.md](../Docs/README.md)                                           | Documentation index for the whole system                            |

Both executables publish self-contained (`win-x64`, single file, untrimmed - trimming breaks
`System.Management`'s reflective WMI types).

---

## Running the whole stack locally

Requires .NET 10 SDK, Node 20+, and a local PostgreSQL.

### 1. Backend

```bash
cd Backend
cp .env.example .env          # set DATABASE_URL, BETTER_AUTH_SECRET, DEVICE_TOKEN_PEPPER
npx prisma migrate dev
npm run seed                  # prints the agent enrollment token - save it
npm run dev                   # http://localhost:5000
```

`npm test` runs an integration smoke test against the real database: enrollment, auth
boundaries, per-channel validation, column-level persistence, idempotency, and the kill switch.

### 2. Dashboard

```bash
cd Frontend
cp .env.example .env.local    # MONITORING_API_URL=http://localhost:5000
npm run dev                   # http://localhost:3000
```

Sign in with the seeded account (`admin@example.com` / `ChangeMe123!` unless overridden).

### 3. Agent

The enrollment token is **org-wide** - the same token goes into every install, and each agent
trades it once for its own per-device API key. There is no per-machine provisioning step. For a
fleet rollout (roster import, device assignment, token rotation) see
[../Docs/operations/agent-deployment.md](../Docs/operations/agent-deployment.md).

From an **elevated** PowerShell:

```powershell
cd "Windows Software_v3"
.\scripts\Deploy-Agent.ps1 -Action Install `
    -ServerUrl http://localhost:5000 `
    -EnrollmentToken <token from npm run seed> `
    -AllowInsecureHttp
```

`-AllowInsecureHttp` is for local testing only. Spec section 9 requires HTTPS in production, and
the service refuses a plain-HTTP server address without it.

Other actions: `-Action Status`, `-Action Publish`, `-Action Install [-CleanInstall]`,
`-Action Uninstall [-PurgeData]`. A normal install preserves existing ProgramData; use
`-CleanInstall` to remove it before installing.

For anything beyond your own machine, build the MSI instead - it gives Windows a supported
uninstall and upgrade path, and prompts for the server address and token (or takes them as
properties for an unattended rollout):

```powershell
.\scripts\Deploy-Agent.ps1 -Action Package
msiexec /i .\artifacts\installer\EmployeeMonitorAgent.msi /qn `
        SERVERURL=https://monitoring.example.com ENROLLMENTTOKEN=<token>
```

The device enrolls, appears on the dashboard's **Devices** screen as _Unassigned_, and starts
reporting once an admin assigns it to an employee.

---

## On-disk layout (installed)

```
%ProgramFiles%\Employee Monitor\        both executables
%ProgramData%\EmployeeMonitor\
    agent.config.json                   server URL + enrollment token (installer-written)
    device.key                          DPAPI-protected device API key, LocalMachine scope
    agent.db                            typed telemetry tables + offline queue
    screenshots\                        spool, deleted after successful upload
    logs\                               service-<date>.log, host-s<session>-<date>.log
```

The data directory is ACL'd to SYSTEM and Administrators. `screenshots\` additionally grants
Users modify rights, because the host writes captures there as the logged-on employee.

`logs\` grants Users _write_ but not modify: the host has to create and append to its own file,
yet a standard user should not be able to delete or truncate the agent's history. Ageing files
out is therefore the service's job - `RetentionWorker` sweeps them after 14 days as SYSTEM.

Both processes also log to the Windows Event Log (`EmployeeMonitorAgent`,
`EmployeeMonitorHost`). The files are the ones to collect when diagnosing a workstation; the
Event Log is there for anything that fails before the file sink can open, and for fleet-wide
monitoring that already scrapes it.

---

## Storage rule

No serialized documents, in Postgres or SQLite. Every telemetry field has its own typed column.
The local queue therefore stays inspectable with any SQL client, and a malformed value fails at
collection time rather than surfacing as a 400 from the server minutes later.

Rows carry `sent_utc` / `attempts`; the sync worker marks only server-acknowledged ids as sent,
and the retention sweep is what finally deletes them - Features.md's "deleting local copies only
after successful synchronization".
