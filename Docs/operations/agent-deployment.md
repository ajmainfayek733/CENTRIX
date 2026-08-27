# Agent deployment

Installing, updating and removing the Windows agent across a fleet.

There are three paths, and they are not alternatives to each other:

| | Use for | Artifact |
|---|---|---|
| **Bundle** | Fleet rollout - copied to a workstation and installed by double-clicking `install.bat`, or driven unattended from GPO/Intune/PDQ. **No .NET runtime or SDK on the target.** | `artifacts/deploy/EmployeeMonitorAgent-<version>/` (and `.zip`) |
| **MSI** | GPO/Intune/ConfigMgr where a native MSI is required. A single self-contained `.msi` - both executables are embedded, and running it self-elevates | `artifacts/installer/EmployeeMonitorAgent.msi` |
| **`Deploy-Agent.ps1`** | Development and single-machine work on the build box, where publishing and installing in one step is the point | none, installs from `artifacts/agent` |

All three write their configuration through the **same** entry point in the agent
(`EmployeeMonitor.Service.exe --configure`), so a machine installed any way ends up with an
identical layout. All require **elevation**.

The bundle is the recommended fleet artifact: it is fully self-contained, so the 30+ target
workstations need nothing installed beforehand, and installing only copies files and configures the
service - it never builds anything.

---

## 1. The bundle (recommended)

Built by `.\scripts\Deploy-Agent.ps1 -Action Bundle -Compress`, which publishes both executables
self-contained and then assembles a redistributable folder:

```
EmployeeMonitorAgent-<version>/
    install.bat                     start here - double-click it
    Install-Agent.ps1               the installer; install.bat calls it
    EmployeeMonitor.Service.exe     the SYSTEM service (carries its own .NET runtime)
    EmployeeMonitor.Host.exe        the per-user session process
    appsettings.json                logging configuration
    README.txt                      operator instructions
```

`-Compress` also writes `EmployeeMonitorAgent-<version>.zip`. The build filters out `*.pdb` and
`appsettings.Development.json`, so nothing developer-only reaches a workstation.

### On one machine

Copy the whole folder to the workstation (USB stick or file share), double-click `install.bat`,
approve the elevation prompt, choose **[1] Install**, and type the server address and enrollment
token when asked. The menu also offers reinstall, uninstall, uninstall-with-purge, status and quit.

`install.bat` self-elevates: launched without administrator rights it re-launches itself through
UAC rather than failing. The prompts for server URL, token and insecure-HTTP live in the PowerShell
half, so a pasted token containing `&`, `^` or `%` is not mangled by `cmd`.

### Across the fleet, unattended

Put the folder on a share and run, elevated, on each machine:

```
powershell -NoProfile -ExecutionPolicy Bypass ^
  -File "\\fileserver\deploy\EmployeeMonitorAgent-<version>\Install-Agent.ps1" ^
  -Action Install ^
  -ServerUrl https://monitoring.example.com ^
  -EnrollmentToken %ENROLL_TOKEN%
```

That form prompts for nothing; exit code 0 means success. `install.bat <action>` (one of `install`,
`reinstall`, `uninstall`, `uninstall-purge`, `status`) does the same after self-elevating.

The install registers an **Add/Remove Programs** entry (spec section 3: the agent must be
discoverable, never disguised), whose uninstall command points at a copy of `install.bat` placed
beside the binaries. Uninstall from there leaves `%ProgramData%\EmployeeMonitor` in place unless
launched with the purge option.

## 2. The MSI

Built by `.\scripts\Deploy-Agent.ps1 -Action Package`, which publishes the agent and then builds
`installer\EmployeeMonitor.Installer.wixproj` around the published output.

The result is a **single self-contained file**. Both executables are compressed into cabinets
embedded in the `.msi` itself (`MediaTemplate EmbedCab="yes"`), so there is nothing to distribute
beside it, and because they publish self-contained the target needs no .NET runtime. The `.wixpdb`
written alongside is installer debug symbols, not part of the deployment. Double-clicking the MSI
self-elevates through UAC (it is a perMachine package).

The configuration page is inserted into the WixUI sequence between the install-location page and the
confirmation page. Its forward transition is ordered **above** WixUI's own jump to the confirmation
page (see `ConfigurationDialog.wxs`): MSI lets the highest-ordered `NewDialog` win, so a lower order
silently skips the page - which is exactly the bug that hid it before.

### Interactive

Running the MSI directly walks an administrator through licence, install location, and a
**configuration page** carrying the three settings the agent cannot start without:

| Field | Property | Notes |
|---|---|---|
| Server address | `SERVERURL` | e.g. `https://monitoring.example.com` |
| Enrollment token | `ENROLLMENTTOKEN` | Masked on screen; from the dashboard under Settings - Organization |
| Allow an insecure HTTP server address | `ALLOWINSECUREHTTP` | Checkbox. Test servers only |

**Next stays disabled** until there is a server and a token and the address is either HTTPS or the
checkbox is ticked. The same three rules are enforced as launch conditions, because a dialog
cannot validate an install that never shows one.

### Silent

The same properties on the command line - this is how a fleet is actually deployed:

```
msiexec /i EmployeeMonitorAgent.msi /qn ^
        SERVERURL=https://monitoring.example.com ^
        ENROLLMENTTOKEN=%ENROLL_TOKEN%
```

A missing or non-HTTPS property fails immediately with a named message rather than installing a
service that cannot enroll. Add `ALLOWINSECUREHTTP=1` for a test server. To capture a log:
`/l*v install.log` - the token is registered in `MsiHiddenProperties`, so it is redacted there.

Uninstall with `msiexec /x EmployeeMonitorAgent.msi /qn`, or from Apps and Features. Uninstall
**leaves `%ProgramData%\EmployeeMonitor` in place**, collected data included; remove it separately
if that is what you want.

Upgrades are major upgrades: install the new MSI over the old one and it replaces it, keeping
`%ProgramData%` - so no re-enrollment and nothing queued is lost.

## 3. The build script

Runs on the build box, where the .NET SDK is. Its `Install`, `Uninstall` and `Status` actions call
`scripts\payload\Install-Agent.ps1` - the same script the bundle ships - so a developer machine and
a workstation follow one code path.

| Action | Does |
|---|---|
| `-Action Publish` | Builds both executables self-contained into `artifacts/agent` |
| `-Action Bundle [-Compress]` | Publishes, then assembles the redistributable folder (and `.zip`) into `artifacts/deploy` |
| `-Action Package` | Publishes, then builds the MSI into `artifacts/installer` |
| `-Action Install` | Publishes, then installs on this machine from the fresh output |
| `-Action Uninstall [-PurgeData]` | Stops and removes the service; `-PurgeData` also deletes `%ProgramData%\EmployeeMonitor` |
| `-Action Status` | Reports service state, version, server, enrollment and queue depth |

```powershell
cd "Windows Software_v3"
.\scripts\Deploy-Agent.ps1 -Action Install `
    -ServerUrl https://monitoring.example.com `
    -EnrollmentToken $env:ENROLL_TOKEN
```

`-AllowInsecureHttp` permits a plain-HTTP server address. Local testing only - the service refuses
one otherwise, because the spec requires TLS in production.

## 4. Fleet rollout order

1. **Create the organization.** `POST /v1/dashboard/organizations` returns the enrollment token
   **once**. Store it; only its HMAC is persisted.
2. **Import the roster** *before* the rollout, so devices have somewhere to be assigned.
   Employees screen -> *Import roster* -> paste `name, email, department`, one per line.
   Tab-separated text pasted from a spreadsheet works, a header row is ignored, and re-importing a
   file containing existing people skips them rather than failing.
3. **Roll the agent out** with the same token on every machine.
4. **Assign each device.** Devices screen -> the *Assigned to* dropdown.

**Step 4 is not cosmetic.** Until a device is assigned it sits on the hidden "Unassigned Devices"
placeholder employee: its telemetry is stored but never reaches per-employee reports.

## 5. What happens on the wire

Each agent trades the org token for its **own** 32-byte API key, stored DPAPI-protected at
`LocalMachine` scope so the SYSTEM service can read it at boot before any user logs on. Only the
key's HMAC is persisted server-side. The org token is never used again on that machine.

Two properties worth knowing:

- **Re-enrollment is idempotent on MachineGuid and preserves the employee assignment.** A
  re-imaged or reinstalled workstation gets a fresh key and keeps its person, with no admin action.
- **The kill switch survives reinstall.** A deactivated device gets 403 at enrollment, so
  reinstalling is not a way around deactivation.

## 6. Token rotation

`POST /v1/dashboard/organizations/:id/enrollment-token` issues a new token. Already-issued device
keys keep working.

**The cost:** every `agent.config.json` in the fleet now holds a stale token, so any machine that
later loses `device.key` cannot re-enroll until you push a new config. Rotate after rollout if you
want to limit the shared secret's exposure, but plan to redistribute config.

## 7. Installed layout

```
%ProgramFiles%\Employee Monitor\        both executables, published side by side
%ProgramData%\EmployeeMonitor\
    agent.config.json                   server URL + enrollment token (installer-written)
    device.key                          DPAPI-protected device API key, LocalMachine scope
    agent.db                            typed telemetry tables + offline queue (WAL)
    screenshots\                        spool, deleted after successful upload
    logs\                               service-<date>.log, host-s<session>-<date>.log
```

The layout and its ACLs are applied by `EmployeeMonitor.Service.exe --configure`, which every
install path calls - the bundle and `Deploy-Agent.ps1` through `Install-Agent.ps1`, the MSI from a
deferred custom action. It is in the agent
rather than in either installer because the service depends on this layout at runtime, so there is
one definition of it, in the codebase that has to agree with it. Identities are resolved from
well-known SIDs rather than names like `BUILTIN\Users`, which do not exist on a localized Windows.

ACLs applied:

- The root is protected (inheritance disabled) and granted only to SYSTEM and Administrators, so a
  standard user cannot read or tamper with collected data on their own machine.
- `screenshots\` additionally grants Users **Modify** - the host writes captures there as the
  logged-on employee.
- `logs\` grants Users **Write + ReadAndExecute**, not Modify. The host must create and append to
  its own log file, but a standard user should not be able to delete or truncate the agent's
  history. Ageing log files out is therefore `RetentionWorker`'s job, running as SYSTEM.

Both executables must land in the **same folder** - the supervisor resolves
`EmployeeMonitor.Host.exe` next to the service executable.

## 8. Service recovery

Restart on failure, with the failure counter reset daily. **The install paths differ slightly** in
the delay, because they configure the SCM through different mechanisms:

| Path | Recovery actions |
|---|---|
| MSI (`util:ServiceConfig`) | restart after 5 s on each of the first three failures |
| Bundle / `Deploy-Agent.ps1` (`sc.exe failure`) | restart after 5 s twice, then 60 s |

The daily reset is the part that matters either way: a machine that crashes once a week never
accumulates enough failures to stop being restarted, while a genuine crash loop stops after the
third attempt until the period rolls over.

Separately, `HostSupervisorWorker` keeps the user-session host alive, checking every 15 s and
reacting to `SessionSwitch` events so a new user's host comes up in about a second. After 5 fast
failures it widens to a 5-minute backoff rather than spamming the Event Log.

## 9. Build constraints

Both executables publish self-contained, `win-x64`, single-file, **untrimmed**.

**Trimming silently disables USB collection** - it breaks `System.Management`'s reflectively
resolved WMI types, and does so at runtime rather than at build time. `Directory.Build.props`
fixes the target framework, RID, version metadata and `TreatWarningsAsErrors`.

WiX is pinned to **5.0.2** in `installer/EmployeeMonitor.Installer.wixproj`, and the `Util` and
`UI` extension references must carry the same version. v6+ requires accepting the paid Open Source
Maintenance Fee EULA (`WIX7015`); a version mismatch between the SDK and an extension gives
`WIX6101`. See [../architecture/decisions.md](../architecture/decisions.md) AD-14.

The installer **packages an already-published directory** rather than building the agent itself:
the publish settings that must not change live with the code that depends on them. It fails with a
named error if that directory is missing, and excludes symbols and `appsettings.Development.json`
from the payload.

Two WiX behaviours worth knowing before editing the authoring, because both fail quietly:

- **An unreferenced `Fragment` is dropped at link time with no diagnostic.** A property, custom
  action or dialog authored in a fragment that nothing references compiles, links, and produces an
  MSI without it. Properties named only in a condition do not count as a reference.
- **`ICE61` is suppressed**, and only that one, because `AllowSameVersionUpgrades` necessarily
  puts the product's own version in its upgrade range.

## 10. Updating

**Bundle:** copy the newer bundle to the machine and choose **[2] Reinstall** (or run
`install.bat reinstall`). It stops the service, replaces the binaries and settings, and restarts,
leaving `%ProgramData%` untouched.

**MSI:** install the newer package over the installed one. `MajorUpgrade` removes the old version
first, and `ServiceControl` stops the service so the executable lock is released before the new
file is written.

**Build script:** re-run `-Action Install`. It stops the service, replaces the binaries and restarts.

Either way the device credential, queue and configuration in `%ProgramData%` are untouched, so no
re-enrollment occurs and nothing queued is lost.

If a contract-breaking change is involved, see
[../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md) for whether the
server or the agent must be deployed first - events already queued under the old contract are the
thing to reason about.

---

## Related

- [../agent/architecture.md](../agent/architecture.md) - what is being deployed
- [backend-deployment.md](backend-deployment.md) - the server side of onboarding
- [troubleshooting.md](troubleshooting.md) - section 8, installation failures
- [../operations/diagnostics.md](diagnostics.md) - agent logs
