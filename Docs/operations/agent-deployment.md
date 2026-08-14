# Agent deployment

Installing, updating and removing the Windows agent across a fleet.

Script: `Windows Software_v3/scripts/Deploy-Agent.ps1`. Every action requires an **elevated**
PowerShell.

---

## 1. The script

| Action | Does |
|---|---|
| `-Action Publish` | Builds both executables self-contained into `artifacts/agent` |
| `-Action Install` | Publishes, copies to Program Files, writes config, sets ACLs, registers the service with recovery options, starts it |
| `-Action Uninstall [-PurgeData]` | Stops and removes the service; `-PurgeData` also deletes `%ProgramData%\EmployeeMonitor` |
| `-Action Status` | Reports service state and installed version |

```powershell
cd "Windows Software_v3"
.\scripts\Deploy-Agent.ps1 -Action Install `
    -ServerUrl https://monitoring.example.com `
    -EnrollmentToken $env:ENROLL_TOKEN
```

The script is **unattended-safe and idempotent**, so it can be pushed via GPO startup script,
Intune or PDQ.

`-AllowInsecureHttp` permits a plain-HTTP server address. Local testing only - the service refuses
one otherwise, because the spec requires TLS in production.

## 2. Fleet rollout order

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

## 3. What happens on the wire

Each agent trades the org token for its **own** 32-byte API key, stored DPAPI-protected at
`LocalMachine` scope so the SYSTEM service can read it at boot before any user logs on. Only the
key's HMAC is persisted server-side. The org token is never used again on that machine.

Two properties worth knowing:

- **Re-enrollment is idempotent on MachineGuid and preserves the employee assignment.** A
  re-imaged or reinstalled workstation gets a fresh key and keeps its person, with no admin action.
- **The kill switch survives reinstall.** A deactivated device gets 403 at enrollment, so
  reinstalling is not a way around deactivation.

## 4. Token rotation

`POST /v1/dashboard/organizations/:id/enrollment-token` issues a new token. Already-issued device
keys keep working.

**The cost:** every `agent.config.json` in the fleet now holds a stale token, so any machine that
later loses `device.key` cannot re-enroll until you push a new config. Rotate after rollout if you
want to limit the shared secret's exposure, but plan to redistribute config.

## 5. Installed layout

```
%ProgramFiles%\Employee Monitor\        both executables, published side by side
%ProgramData%\EmployeeMonitor\
    agent.config.json                   server URL + enrollment token (installer-written)
    device.key                          DPAPI-protected device API key, LocalMachine scope
    agent.db                            typed telemetry tables + offline queue (WAL)
    screenshots\                        spool, deleted after successful upload
    logs\                               service-<date>.log, host-s<session>-<date>.log
```

ACLs set by the script:

- The root is protected (inheritance disabled) and granted only to SYSTEM and Administrators, so a
  standard user cannot read or tamper with collected data on their own machine.
- `screenshots\` additionally grants Users **Modify** - the host writes captures there as the
  logged-on employee.
- `logs\` grants Users **Write + ReadAndExecute**, not Modify. The host must create and append to
  its own log file, but a standard user should not be able to delete or truncate the agent's
  history. Ageing log files out is therefore `RetentionWorker`'s job, running as SYSTEM.

Both executables must land in the **same folder** - the supervisor resolves
`EmployeeMonitor.Host.exe` next to the service executable.

## 6. Service recovery

Registered with `sc.exe failure`: restart after 5 s twice, then 60 s, counter reset daily.

Separately, `HostSupervisorWorker` keeps the user-session host alive, checking every 15 s and
reacting to `SessionSwitch` events so a new user's host comes up in about a second. After 5 fast
failures it widens to a 5-minute backoff rather than spamming the Event Log.

## 7. Build constraints

Both executables publish self-contained, `win-x64`, single-file, **untrimmed**.

**Trimming silently disables USB collection** - it breaks `System.Management`'s reflectively
resolved WMI types, and does so at runtime rather than at build time. `Directory.Build.props`
fixes the target framework, RID, version metadata and `TreatWarningsAsErrors`.

WiX is pinned to **5.0.2**, with `Util`, `UI` and `Firewall` extensions version-matched. v6+
requires accepting the paid Open Source Maintenance Fee EULA (`WIX7015`); a version mismatch
between CLI and extensions gives `WIX6101`. See
[../architecture/decisions.md](../architecture/decisions.md) AD-14.

## 8. Updating

Re-run `-Action Install`. It stops the service, replaces the binaries and restarts. The device
credential, queue and configuration in `%ProgramData%` are untouched, so no re-enrollment occurs
and nothing queued is lost.

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
