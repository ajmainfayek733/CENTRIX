# Workforce Agent — IT Administrator Deployment Guide

This is a step-by-step guide for deploying the Workforce Agent to an employee's Windows machine
and connecting it to the backend, written for someone doing this for the first time. No prior
knowledge of the codebase is assumed. Where a step can be automated, a ready-made script is
provided — see `Windows Software/scripts/`.

If you only need to know _how the device API key is generated_, jump to [§2](#2-how-the-device-api-key-works).

---

## 1. How the pieces fit together

```
 ┌────────────────────┐        HTTPS, Bearer <device API key>        ┌──────────────────────┐
 │  Employee's laptop  │ ───────────────────────────────────────────▶ │       Backend         │
 │                     │                                              │  (Backend/, Node/TS)  │
 │  Agent.Host          │  Windows Service — always running,          │  Postgres database    │
 │  (Session 0)          │  even if no one is logged in                │                       │
 │                     │                                              │                       │
 │  Agent.TrayHelper    │  Runs per logged-in user — shows the        │                       │
 │  (interactive)        │  consent notice, captures foreground        │                       │
 │                     │  window/browser/screenshot data              │                       │
 └────────────────────┘                                              └──────────────────────┘
```

- **Agent.Host** and **Agent.TrayHelper** are two processes that make up "the Agent" on one
  machine. Both need to be installed.
- Neither process can talk to the backend until the _device_ (the physical machine) has been
  **registered** and given an **API key**. That's what causes a fresh install to log `401
Unauthorized` — it's expected until you complete §4–§5 below, not a bug.
- The consent notice (a dialog asking the employee to acknowledge monitoring) shows once per
  machine, the first time any user logs in after install, and is never shown again unless your
  organization publishes a materially updated policy.

---

## 2. How the device API key works

You don't need to generate anything yourself — the backend generates the key when you register a
device (§5). This section just explains what's actually happening, for your own understanding:

1. When you call the device-registration endpoint, the backend generates **256 bits of
   cryptographically random data** (`crypto.randomBytes(32)`, not a predictable value) and
   hex-encodes it into a 64-character string. That string _is_ the API key.
2. The backend never stores that raw string. It runs it through **HMAC-SHA256** together with a
   server-side secret (`DEVICE_TOKEN_PEPPER`, set in the backend's `.env`, never sent to any
   client) and stores only the resulting hash in the `Device.apiKeyHash` column.
3. The raw key is returned to you **exactly once**, in the API response — the backend has no way
   to show it to you again after that. If you lose it, you cannot recover it; you'd need to
   deactivate that device row and register a new one.
4. From then on, the Agent sends `Authorization: Bearer <that raw key>` on every request. The
   backend re-computes the HMAC of whatever key it receives and looks it up by that hash. A match
   means "this is a legitimate, previously-registered device"; no match returns `401`; a match
   against a device an admin has deactivated returns `403`.
5. Because the stored value is a _keyed_ hash (HMAC), even a full database leak doesn't expose
   usable device keys — an attacker would also need `DEVICE_TOKEN_PEPPER`, which only lives in
   the backend's environment. That variable is itself the most sensitive secret in this system —
   treat it like a password, and make sure it's a real random value in production, not the dev
   default in `.env.example`.

On the Agent side, the raw key is written once into a machine-scoped environment variable and
imported into a DPAPI-encrypted local file (`C:\ProgramData\WorkforceAgent\keys\device.key`,
readable only on that machine) — see §7.2. It's never stored in plaintext on disk.

---

## 3. Prerequisites

- The backend (`Backend/`) is already running and reachable from the employee's machine over
  HTTPS (or `http://` for local testing only — see the security note in §10).
- You have (or will create in §4) a **Super Admin** dashboard account.
- The target machine runs Windows 10/11 and has the **.NET 10 Desktop Runtime** installed
  (`Microsoft.WindowsDesktop.App` — the Agent is _not_ self-contained by default; see §6 if you'd
  rather avoid installing this on every machine).
- You can open an elevated (Administrator) PowerShell prompt on the target machine.

---

## 4. One-time backend setup

Run these from any machine that can reach the backend (your own PC is fine — you don't have to
run this on the employee's machine). Examples use PowerShell's `Invoke-RestMethod`, which handles
session cookies for you via `-SessionVariable` / `-WebSession`.

```powershell
$baseUrl = "https://monitoring.yourcompany.com"   # or http://localhost:5000 while testing locally
```

### 4.1 Create the first Super Admin account (one-time only)

```powershell
Invoke-RestMethod -Method Post -Uri "$baseUrl/api/auth/sign-up/email" -ContentType "application/json" -Body (@{
    name     = "IT Admin"
    email    = "admin@yourcompany.com"
    password = "Use-A-Real-Password-123!"
    role     = "super_admin"
} | ConvertTo-Json)
```

### 4.2 Log in (this is what actually gives you a usable session)

```powershell
Invoke-RestMethod -Method Post -Uri "$baseUrl/api/auth/sign-in/email" -ContentType "application/json" `
    -SessionVariable session `
    -Body (@{ email = "admin@yourcompany.com"; password = "Use-A-Real-Password-123!" } | ConvertTo-Json) | Out-Null
```

`$session` now holds your login cookie. Reuse it (`-WebSession $session`) on every call below —
don't log in again.

### 4.3 Create an Organization (one-time per company/tenant)

```powershell
$org = Invoke-RestMethod -Method Post -Uri "$baseUrl/v1/dashboard/organizations" -WebSession $session `
    -ContentType "application/json" -Body (@{ name = "Acme Corp" } | ConvertTo-Json)
$org.id
```

Copy `$org.id` — you'll need it below.

### 4.4 Create an Employee record

Do this once per person whose device you're going to monitor:

```powershell
$employee = Invoke-RestMethod -Method Post -Uri "$baseUrl/v1/dashboard/employees" -WebSession $session `
    -ContentType "application/json" -Body (@{
        organizationId = $org.id
        name           = "Jane Doe"
        email          = "jane.doe@yourcompany.com"
        department     = "Engineering"
    } | ConvertTo-Json)
$employee.id
```

Copy `$employee.id`.

---

## 5. Register the device and get its API key

You need the machine's **MachineGuid** first. Run this **on the employee's PC** (or have them run
it and send it to you — it's not sensitive):

```powershell
(Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Cryptography").MachineGuid
```

Then, back on your admin machine, using the same `$session` from §4.2:

```powershell
$device = Invoke-RestMethod -Method Post -Uri "$baseUrl/v1/dashboard/employees/devices" -WebSession $session `
    -ContentType "application/json" -Body (@{
        employeeId   = $employee.id
        machineId    = "<paste the MachineGuid here>"
        hostname     = "JANE-LAPTOP"
        os           = "Windows 11 Pro"
        agentVersion = "0.1.0"
    } | ConvertTo-Json)

$device.rawApiKey
```

**Copy `$device.rawApiKey` immediately and store it somewhere secure (a password manager, not a
chat message) — the backend will never show it to you again.** You'll paste it into
`Install-Agent.ps1` in §7.

If you register the wrong machine or need to reissue a key, see §9 (there's no "regenerate" —
you deactivate the old device and register a new one).

---

## 6. Build the Agent (once per release, not once per machine)

From a machine with the .NET 10 SDK installed (this does not need to be the employee's machine —
build once, deploy the same output everywhere):

```powershell
cd "Windows Software\src"
dotnet publish Agent.Host\Agent.Host.csproj        -c Release -o C:\Deploy\WorkforceAgent\Agent.Host
dotnet publish Agent.TrayHelper\Agent.TrayHelper.csproj -c Release -o C:\Deploy\WorkforceAgent\Agent.TrayHelper
```

This produces a **framework-dependent** build — every target machine needs the .NET 10 Desktop
Runtime installed (see §3). If you'd rather ship something that doesn't require installing a
runtime on every machine, add `-r win-x64 --self-contained true -p:PublishSingleFile=true` to
both commands, at the cost of a larger deployment folder.

Copy the `C:\Deploy\WorkforceAgent` folder (or a zip of it) to the target machine, or to a network
share reachable from it — `Install-Agent.ps1` in §7 reads from wherever you put it.

---

## 7. Install the Agent on the employee's machine

### Option A — automated (recommended)

From an elevated PowerShell prompt **on the employee's machine**, with the published output from
§6 available locally (copy the `C:\Deploy\WorkforceAgent` folder over first):

```powershell
cd "Windows Software\scripts"
.\Install-Agent.ps1 `
    -PublishSourceRoot "C:\Deploy\WorkforceAgent" `
    -BackendBaseUrl "https://monitoring.yourcompany.com/" `
    -DeviceApiKey "<paste the rawApiKey from §5>"
```

This copies both processes into `C:\Program Files\WorkforceAgent`, points them at your backend,
stores the device API key, installs `Agent.Host` as a Windows Service (name: `WorkforceAgent`,
starts automatically, runs as LocalSystem), and adds `Agent.TrayHelper` to the all-users Startup
folder so it launches whenever anyone logs in. It starts the service for you at the end.

To remove everything later, run `Uninstall-Agent.ps1` from the same folder (see its help text for
the `-Purge` option).

### Option B — manual steps (what the script above does, if you need to do it by hand)

1. Copy the published `Agent.Host` and `Agent.TrayHelper` folders somewhere permanent, e.g.
   `C:\Program Files\WorkforceAgent\Agent.Host` and `...\Agent.TrayHelper`.
2. In **both** folders' `appsettings.json`, set:
   ```json
   {
     "Agent": {
       "BackendBaseUrl": "https://monitoring.yourcompany.com/",
       "DataDirectory": "C:\\ProgramData\\WorkforceAgent"
     }
   }
   ```
3. Set the device API key as a **machine-scoped** environment variable (not user-scoped — the
   service runs as LocalSystem and needs to see it too):
   ```powershell
   [Environment]::SetEnvironmentVariable('WORKFORCEAGENT_DEVICE_API_KEY', '<rawApiKey>', 'Machine')
   ```
4. Install `Agent.Host.exe` as a Windows Service:
   ```powershell
   New-Service -Name WorkforceAgent -BinaryPathName "C:\Program Files\WorkforceAgent\Agent.Host\Agent.Host.exe" -DisplayName "Workforce Agent" -StartupType Automatic
   Start-Service WorkforceAgent
   ```
5. Make `Agent.TrayHelper.exe` launch at logon for every user — the simplest way is a shortcut in
   the all-users Startup folder:
   ```powershell
   $shell = New-Object -ComObject WScript.Shell
   $shortcut = $shell.CreateShortcut("$([Environment]::GetFolderPath('CommonStartup'))\Workforce Agent.lnk")
   $shortcut.TargetPath = "C:\Program Files\WorkforceAgent\Agent.TrayHelper\Agent.TrayHelper.exe"
   $shortcut.Save()
   ```

### 7.1 What the employee sees

The next time someone logs into the machine, `Agent.TrayHelper` starts, sees there's no consent
record for this machine yet, and shows the monitoring notice (§8 of
`docs/terms-of-service.md` — the dialog itself links to the full Terms of Use and Privacy Policy).
Nothing is collected or transmitted until they check the box and click **I Acknowledge & Agree**.
That acknowledgement is then saved locally and synced to the backend, and — this is the "for the
entire lifecycle of the agent" behavior you may have been told to expect — it is not asked again
on this machine, for any user, unless your organization publishes a new policy version.

---

## 8. Verify it worked

- **On the machine**: check `C:\ProgramData\WorkforceAgent\logs\agent-*.log` (the service) and
  `tray-*.log` (the tray app). Look for `"Device enrolled successfully"` and the absence of
  repeated `401`/`403` warnings.
- **Service status**: `Get-Service WorkforceAgent` should show `Running`.
- **From the backend/dashboard side**: after a few minutes, query the device and confirm
  `lastSeenAt` is recent:
  ```powershell
  (Invoke-RestMethod -Uri "$baseUrl/v1/dashboard/employees/$($employee.id)" -WebSession $session).devices
  ```

If `lastSeenAt` stays `null`, see §10.

---

## 9. Deactivating, rotating, or removing a device

- **Employee leaves / device retired**: deactivate it so it can no longer authenticate —
  ```powershell
  Invoke-RestMethod -Method Patch -Uri "$baseUrl/v1/dashboard/employees/devices/$($device.deviceId)/status" `
      -WebSession $session -ContentType "application/json" -Body (@{ isActive = $false } | ConvertTo-Json)
  ```
  Then run `Uninstall-Agent.ps1 -Purge` on the machine if it's being reimaged/repurposed.
- **Suspected key compromise**: there is no "rotate in place" endpoint. Deactivate the device row
  above, register a brand new one (§5) for the same employee/machine, then re-run
  `Install-Agent.ps1` on the machine with the new key (it overwrites the old service/credential).
- **Lost the raw API key before finishing install**: same as above — you cannot retrieve it, only
  issue a new one.

---

## 10. Troubleshooting

| Symptom                                                        | Likely cause                                                                                                                                                        | Fix                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Logs show `401` repeatedly, `"This device is not enrolled"`    | `WORKFORCEAGENT_DEVICE_API_KEY` was never set, or was set _after_ the Agent last started                                                                            | Set it (§7.2/§7 Option B step 3), then **restart both the service and log the user out/in** — environment variable changes aren't picked up by already-running processes |
| Logs show `401`, `"Backend rejected this device's credential"` | Key was mistyped/truncated when pasted, or this device was deactivated and re-registered under a new key without updating the machine                               | Re-check the exact `rawApiKey` value from §5; re-run `Install-Agent.ps1` with the correct one                                                                            |
| Logs show `403`                                                | Device was deliberately deactivated by an admin (§9)                                                                                                                | Reactivate it (`isActive: true`) via the same PATCH endpoint, or register a new device if that was intentional                                                           |
| No consent dialog ever appears                                 | `Agent.TrayHelper` isn't launching — check the Startup folder shortcut exists and points to a valid path; check Task Manager for `Agent.TrayHelper.exe` after logon | Re-run §7 step 5, or check `tray-*.log` for a startup exception                                                                                                          |
| Consent dialog reappears every login for the same user         | You're looking at a build from before this was fixed to be machine-scoped, or the local SQLite DB (`agent.db`) was deleted/reset                                    | Update the Agent; don't delete `C:\ProgramData\WorkforceAgent\agent.db` as part of any cleanup step                                                                      |
| `New-Service` fails with "service already exists"              | A previous install wasn't cleaned up                                                                                                                                | Run `Uninstall-Agent.ps1` first, or `sc.exe delete WorkforceAgent` manually                                                                                              |
| Backend itself returns `500` on device registration            | `DEVICE_TOKEN_PEPPER` unset/misconfigured, or the database migration hasn't been applied                                                                            | Check `Backend/.env` and run `npx prisma migrate deploy` in `Backend/`                                                                                                   |

---

## 11. Security notes

- Treat the device API key exactly like a password while it's in transit from §5 to §7 — don't
  paste it into chat tools or tickets that aren't access-controlled. Once it's imported into the
  Agent's DPAPI store, it never needs to be typed again.
- `DEVICE_TOKEN_PEPPER` (backend) and `BETTER_AUTH_SECRET` (backend) are the two most sensitive
  values in this system. The backend now refuses to start in production with the checked-in dev
  default for `DEVICE_TOKEN_PEPPER` — make sure both are real random values in `Backend/.env` and
  are not committed to git.
- Use `https://` for `BackendBaseUrl` in any real deployment. `http://` is acceptable only for
  local development against `localhost`.
