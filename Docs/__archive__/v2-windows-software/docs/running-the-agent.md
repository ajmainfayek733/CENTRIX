> **ARCHIVED - NOT AUTHORITATIVE.** This document describes an abandoned version of the
> agent. It is kept for history only. Do not build on it.
> The live documentation index is [../../../README.md](../../../README.md); see
> [../../../archive/README.md](../../../archive/README.md) for what superseded this file.

---

# Running the Workforce Agent - Development, Test, and Production

This document covers three distinct ways to run the solution, plus how to inspect the local
database directly. All commands assume a `cmd.exe`/PowerShell prompt on Windows with the .NET 10
SDK installed, from the `d:\Windows Software\src` directory unless noted otherwise.

---

## 0. One-time setup (all modes)

```powershell
cd "D:\Windows Software\src"
dotnet restore
dotnet build
```

Both `Agent.Host` and `Agent.TrayHelper` read `appsettings.json` from their own output directory
for two settings:

```json
{
  "Agent": {
    "DataDirectory": "C:\\ProgramData\\WorkforceAgent",
    "BackendBaseUrl": "https://localhost/"
  }
}
```

`DataDirectory` is where the encrypted SQLite database, DPAPI key files, logs, and cached
screenshots live. **Both processes must point at the same `DataDirectory`** - that's how they
share state without a custom IPC layer (see the architecture notes in the main changelog).
`BackendBaseUrl` only matters once a real backend exists; until then, sync/policy calls will
fail and the Agent falls back to cached/default policy (this is expected, not a bug - see section 2.3).

---

## 1. Development Mode

Development mode runs both processes as ordinary console/WinForms apps under your own user
account - no service installation, no admin rights beyond what the collectors themselves need
(e.g., WMI queries for USB, which work fine under a normal account).

### 1.1 Run the service process interactively

```powershell
cd "D:\Windows Software\src\Agent.Host"
dotnet run
```

`Program.cs` checks `Environment.UserInteractive` and, when true (i.e., not actually running as
a service), calls the same `OnStart`/`OnStop` logic a real service would, then blocks on
`Console.ReadLine()`. Press Enter to stop cleanly. Logs go to
`<DataDirectory>\logs\agent-<date>.log` and to the console.

**Important caveat:** `ServiceBase.OnSessionChange`/`OnPowerEvent` are only ever invoked by the
Service Control Manager (SCM) after `ServiceBase.Run()` registers the process as a real service.
Running interactively via `dotnet run` skips that registration entirely, so **lock/unlock,
logon/logoff, RDP connect/disconnect, and sleep/resume events never fire in this mode** -
Attendance's `Login`/`Logout`/`Lock`/`Unlock`/`SleepStart`/`SleepEnd` rows simply won't appear no
matter what you do on the machine, since Attendance's collector is driven entirely by these
SCM-delivered signals. Everything else (App Session, Active/Idle, Browser Monitor, Screenshots,
USB) is unaffected, since those run in the tray helper or don't depend on session/power
callbacks. To exercise Attendance, install as a real service (section 3) - even a non-code-signed local
install works fine for this purpose; you don't need a production-grade deployment just to see
these events fire.

### 1.2 Run the tray helper interactively

In a second terminal:

```powershell
cd "D:\Windows Software\src\Agent.TrayHelper"
dotnet run
```

This shows the tray icon, and - on first run - the blocking consent dialog. Acknowledge it to
let the interactive collectors (Activity, App Session, Browser Monitor, Screenshot) start. Close
the tray icon (right-click isn't wired to exit; use `Ctrl+C` in the terminal, or Task Manager)
to stop it during development.

### 1.3 Where to look while developing

| What                                | Where                                                                |
| ----------------------------------- | -------------------------------------------------------------------- |
| Encrypted database                  | `<DataDirectory>\agent.db` (see section 4 to inspect it)                    |
| Database/screenshot encryption keys | `<DataDirectory>\keys\db.key`, `<DataDirectory>\keys\screenshot.key` |
| Cached screenshots (encrypted)      | `<DataDirectory>\screenshots\`                                       |
| Cached policy (offline fallback)    | `<DataDirectory>\policy-cache.json`                                  |
| Host logs                           | `<DataDirectory>\logs\agent-<date>.log`                              |
| Tray helper logs                    | `<DataDirectory>\logs\tray-<date>.log`                               |

### 1.4 Resetting to a clean state

Stop both processes, then delete the entire `DataDirectory` (default
`C:\ProgramData\WorkforceAgent`). Both processes recreate it - schema, keys, everything - on
next start. Do this whenever you want to re-trigger the first-run consent dialog or clear out
test data.

### 1.5 Running against a fake backend

Since no real backend exists yet, either:

- Leave `BackendBaseUrl` pointing at an unreachable address (the default) and let sync fail
  silently in the background - fine for testing everything except the sync/policy round trip.
- Stand up a minimal mock server implementing the three endpoints in
  `docs/backend-api-specification.md` (a few lines in any framework - the contract is simple:
  echo back `acknowledgedEventIds` equal to whatever was sent, return a static `PolicyDocument`,
  and `200 OK` any screenshot upload) and point `BackendBaseUrl` at it.

---

## 2. Test Mode

"Test mode" here means two things: running the automated test suite, and manually exercising
each module's edge cases on a real (or VM) Windows machine, since much of this codebase is
Win32/WMI/UIA interop that unit tests can't cover.

### 2.1 Automated tests

```powershell
cd "D:\Windows Software\src"
dotnet test Agent.Tests.Unit/Agent.Tests.Unit.csproj
```

This runs all 118 unit tests (pure domain logic - state machines, decision engines, URL parsing,
reconciliation diffing - no real Windows APIs or database involved). Expect `0` failures; if
something fails after you've changed code, that's a real regression to investigate, not a flaky
test - none of these tests touch the filesystem, network, or a live Windows session.

`Agent.Tests.Integration` is scaffolded but currently empty - it's where SQLite-backed
repository tests (real encrypted database, real file I/O) belong; none have been written yet.

### 2.2 Manual QA checklist

Use this to verify each module end-to-end. After each action, use section 4 to inspect the relevant
table. Most rows work in Development Mode (section 1); the two Attendance rows marked below need the
real Windows Service (section 3) instead, since `Login`/`Logout`/`Lock`/`Unlock`/`Sleep`/`Resume` are
SCM-delivered and never fire under `dotnet run` (see the caveat in section 1.1).

| Module                                     | Action                                                       | Expect                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Attendance _(requires section 3 service install)_ | Lock the workstation (Win+L), wait a few seconds, unlock     | `attendance_events` gets `Lock` then `Unlock` rows                                                                            |
| Attendance _(requires section 3 service install)_ | Sleep/resume the machine                                     | `SleepStart`/`SleepEnd` rows                                                                                                  |
| Attendance _(works in dev mode)_           | Leave the machine idle past 5 minutes, then touch input      | `IdleStart` then `IdleEnd` rows - these come from the tray helper's idle bridge, not the SCM, so they work under `dotnet run` |
| App Session                                | Switch between two applications                              | `app_sessions` gets a closed row for the first app, an open (then closed) row for the second                                  |
| App Session                                | Rename a document / navigate a browser tab                   | A new session row even though the process didn't change (window-title-only change)                                            |
| Active/Idle                                | Leave the machine untouched for 5+ minutes                   | `activity_sessions` transitions to `Idle`                                                                                     |
| Active/Idle                                | Touch the mouse after being idle                             | Transitions back to `Active` (see the Attendance row above for the corresponding `IdleEnd`)                                   |
| Browser Monitor                            | Navigate to a few different sites in Chrome/Edge             | `browser_navigations` gets rows with `domain`/`normalized_url` populated                                                      |
| Screenshot                                 | Enable screenshots (see section 2.3), wait one interval             | A row appears in `screenshots`; an encrypted `.enc` file appears in `<DataDirectory>\screenshots\`                            |
| USB                                        | Insert a USB drive, wait ~5 seconds, remove it               | `usb_events` gets `Inserted` then `Removed` rows for the same `pnp_device_id`                                                 |
| Alerts                                     | Stay idle past 60 minutes (or lower the threshold, see section 2.3) | An `alerts` row appears, and - if the tray helper is running - a balloon notification                                         |

### 2.3 Overriding policy thresholds for faster testing

Policy normally comes from the backend (section 4.2 of the backend spec) with a local fallback to
`PolicyDocument.Default` in `Agent.Core/Policy/PolicyDocument.cs` when unreachable. For faster
manual testing (e.g., a 60-minute idle-alert threshold is impractical to sit through), either:

- Temporarily edit the default values in `PolicyDocument.cs`'s nested policy records (e.g.,
  drop `IdleAlertPolicy.WarningAfter` to `TimeSpan.FromSeconds(30)`) and rebuild, **remembering
  to revert before committing** - this is a code change, not configuration, since there's no
  backend yet to serve overrides from.
- Or point `BackendBaseUrl` at a mock server (section 1.5) that serves a custom `PolicyDocument` with
  whatever thresholds you want, which is the cleaner option and doesn't require reverting code.

### 2.4 Multi-session / RDP testing

Requires a real Windows Service installation (section 3) since interactive `dotnet run` doesn't
register with the SCM. Install the service, RDP into the machine from another device, and watch
`attendance_events` for `RemoteConnect`/`RemoteDisconnect` and the console-session equivalents.

---

## 3. Production Mode

### 3.1 Build for release

```powershell
cd "D:\Windows Software\src"
dotnet publish Agent.Host -c Release -o publish\Agent.Host
dotnet publish Agent.TrayHelper -c Release -o publish\Agent.TrayHelper
```

```bash
#linux. git bash
cd "/Windows Software/src"
dotnet publish Agent.Host -c Release -o publish/Agent.Host
dotnet publish Agent.TrayHelper -c Release -o publish/Agent.TrayHelper
```

**Self Contained version**

```bash
dotnet publish Agent.Host -c Release -r win-x64 --self-contained true -p:PublishReadyToRun -o publish/Agent.Host
dotnet publish Agent.TrayHelper -c Release -r win-x64 --self-contained true -p:PublishReadyToRun -o publish/Agent.TrayHelper
```

Before shipping, per `Rules.md`: code-sign both executables, strip debug symbols from the
distributed package (keep a symbol server copy separately if you want crash diagnostics), and
set `BackendBaseUrl` in each `appsettings.json` to your real backend's HTTPS URL.

### 3.2 Install `Agent.Host` as a Windows Service

Run as Administrator:

```powershell
sc.exe create WorkforceAgent binPath= "C:\Program Files\WorkforceAgent\Agent.Host\Agent.Host.exe" start= auto DisplayName= "Workforce Agent"
sc.exe description WorkforceAgent "Enterprise endpoint monitoring agent - attendance, activity, and policy compliance telemetry."
sc.exe start WorkforceAgent
```

(Note the required space after each `=` - that's `sc.exe`'s syntax, not a typo.) Per `Rules.md`,
this should run under `LocalSystem` (the default) or a dedicated least-privilege service account
if your organization's policy requires one - either way, run with **the minimum privileges
needed**, which for this agent means local admin-equivalent access for WMI/session APIs, not
domain-level rights.

Verify it's running and visible (per the disclosed-monitoring requirement, it must never hide):

```powershell
sc.exe query WorkforceAgent
Get-Service WorkforceAgent
```

It should also appear in Task Manager -> Services, and in Programs and Features once you ship an
installer (not built as part of this deliverable - packaging via MSI/Intune/GPO is a deployment
concern noted in `Rules.md`, not something coded here).

### 3.3 Deploy `Agent.TrayHelper` to run at logon

The tray helper must run in **every** interactive user session, which a service cannot launch
directly without the added complexity of `CreateProcessAsUser` token juggling (deliberately not
built - see the changelog's architecture notes). The standard, enterprise-recommended way to do
this is a **Scheduled Task with an "at logon of any user" trigger**, deployed via Group
Policy/Intune alongside the service install:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Program Files\WorkforceAgent\Agent.TrayHelper\Agent.TrayHelper.exe"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -GroupId "BUILTIN\Users" -RunLevel Limited
Register-ScheduledTask -TaskName "WorkforceAgentTray" -Action $action -Trigger $trigger -Principal $principal
```

This runs the tray helper as whichever user logs on (not elevated), which is exactly what it
needs - everything it does (foreground window polling, UI Automation, screen capture) requires
running at the logged-on user's own privilege level in their own session.

### 3.4 Uninstalling

```powershell
sc.exe stop WorkforceAgent
sc.exe delete WorkforceAgent
Unregister-ScheduledTask -TaskName "WorkforceAgentTray" -Confirm:$false
```

Then remove the installed files and, if you want to purge all locally cached data,
`<DataDirectory>` (default `C:\ProgramData\WorkforceAgent`) - though normal operation already
deletes most local data immediately after a successful sync (section 3.4 of the backend spec).

---

## 4. Inspecting the Database with Beekeeper Studio

**Beekeeper Studio cannot open the Agent's database directly.** The database is encrypted with
SQLCipher (per `Rules.md`'s "encrypt local cache" requirement), and Beekeeper Studio has no
SQLCipher support in any shipped release - the feature request has been open since 2021
([beekeeper-studio#625](https://github.com/beekeeper-studio/beekeeper-studio/issues/625)) and
the pull request adding it is still unmerged. Pointing Beekeeper at `agent.db` directly will
show an unreadable/garbage file, not an error explaining why.

### 4.1 Export a plaintext copy for inspection

A small dev-only tool, `Agent.DevTools`, does the decryption for you using SQLCipher's own
documented `sqlcipher_export()` function
([Zetetic SQLCipher API docs](https://www.zetetic.net/sqlcipher/sqlcipher-api/#sqlcipher_export)):

```powershell
cd "D:\Windows Software\src\Agent.DevTools"
dotnet run -- export-db
```

By default this reads from `C:\ProgramData\WorkforceAgent` and writes a timestamped plaintext
copy to your Desktop, e.g. `agent-plaintext-20260727-143205.db`. Override either:

```powershell
dotnet run -- export-db --data-dir "C:\ProgramData\WorkforceAgent" --output "D:\scratch\agent-plaintext.db"

# Vm Enviroment
dotnet run --project "C:\Users\fayek\OneDrive\Desktop\Project\employee-tracker\Windows Software\src\Agent.DevTools\Agent.DevTools.csproj" -- export-db --data-dir "C:\ProgramData\WorkforceAgent" --output "C:\Users\fayek\OneDrive\Desktop\scratch\agent-plaintext.db"
```

**This must be run on the machine where the Agent is installed** - the encryption key is
protected with Windows DPAPI, which only unprotects on the machine that created it.

### 4.2 Open it in Beekeeper Studio

1. Open Beekeeper Studio -> New Connection -> SQLite.
2. Browse to the plaintext `.db` file the export tool produced.
3. Connect - no password, since this copy is intentionally unencrypted.
4. You should see all nine tables: `outbox`, `attendance_events`, `app_sessions`,
   `activity_sessions`, `browser_navigations`, `screenshots`, `usb_events`, `alerts`,
   `consent_records`.

**Treat the exported file as sensitive** - it contains the same monitoring data as the live
database, just without the encryption-at-rest protection. Delete it once you're done inspecting
it; don't leave it sitting on a shared machine or commit it anywhere.

### 4.3 Quick sanity queries once connected

```sql
-- Is anything actually being written?
SELECT 'attendance' AS t, COUNT(*) FROM attendance_events
UNION ALL SELECT 'app_sessions', COUNT(*) FROM app_sessions
UNION ALL SELECT 'activity_sessions', COUNT(*) FROM activity_sessions
UNION ALL SELECT 'browser_navigations', COUNT(*) FROM browser_navigations
UNION ALL SELECT 'usb_events', COUNT(*) FROM usb_events
UNION ALL SELECT 'alerts', COUNT(*) FROM alerts
UNION ALL SELECT 'outbox (pending sync)', COUNT(*) FROM outbox;

-- Any dangling open sessions? (should be none while the Agent is running normally;
-- a nonzero count right after a crash is expected and should clear after the next restart's
-- recovery pass)
SELECT * FROM app_sessions WHERE end_time_utc IS NULL;
SELECT * FROM activity_sessions WHERE end_time_utc IS NULL;

-- Most recent events per module, to eyeball freshness
SELECT * FROM attendance_events ORDER BY occurred_at_utc DESC LIMIT 10;
SELECT * FROM browser_navigations ORDER BY occurred_at_utc DESC LIMIT 10;
```

### 4.4 Alternative: DB Browser for SQLite (SQLCipher edition)

If you'd rather not export a plaintext copy at all, [DB Browser for
SQLite](https://sqlitebrowser.org/) ships a dedicated **SQLCipher edition** build that can open
the encrypted database directly, prompting for a password. Get the raw key with:

```powershell
cd "D:\Windows Software\src\Agent.DevTools"
dotnet run -- show-key
```

Paste that value into DB Browser's "Encryption password" field when opening `agent.db` (raw key
mode, not passphrase mode - check DB Browser's own SQLCipher-edition documentation for the exact
option name, since this varies by version). This avoids ever writing a plaintext copy to disk,
which is preferable for anything beyond throwaway local testing.

---

## 5. Troubleshooting

| Symptom                                              | Likely cause                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tray helper exits immediately, no consent dialog     | Fixed as of this writing - consent resolution used to call `WTSQueryUserToken`, which needs the `SE_TCB_NAME` privilege held by `LocalSystem` and fails silently under a normal account. It now reads the process's own identity instead (`WindowsIdentity.GetCurrent()`). If you still see this, check `tray-<date>.log` for the actual exception. |
| No rows appearing in any table                       | Check `policyProvider.Current.*.Enabled` - if policy has a module disabled (Screenshots are **off by default**), nothing will be collected for it                                                                                                                                                                                                   |
| `agent.db` won't open in any tool, even after export | Confirm both processes are pointed at the _same_ `DataDirectory` - a mismatch means you're looking at (or exporting) an empty database created fresh by whichever process ran first                                                                                                                                                                 |
| Service won't start                                  | Check Windows Event Viewer -> Application log for the .NET unhandled exception, and `<DataDirectory>\logs\agent-<date>.log`; most common cause during development is a locked `agent.db` from a `dotnet run` instance still running                                                                                                                  |
