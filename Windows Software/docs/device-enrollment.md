# Device Enrollment (Agent ↔ Backend Authentication)

This describes how a Workforce Agent installation gets a credential that lets it talk to the
backend, and why a freshly-installed Agent returns `401 Unauthorized` until this is done.

## Why devices start out getting 401s

The backend authenticates every Agent request with a per-device API key (`Authorization: Bearer
<key>`, see `Backend/src/middleware/deviceAuth.ts`). That key does not exist until an
administrator explicitly registers the device — there is no self-service "phone home and
register yourself" endpoint, by design: an unauthenticated enrollment endpoint would let anyone
register an arbitrary device against any employee. Until a device is registered and its key is
provisioned onto the machine, every backend call it makes will correctly receive `401 Unauthorized:
Invalid device credential`.

## One-time setup, per device

1. **Create the employee** (if not already present), via `POST /v1/dashboard/employees` (super
   admin only, requires a dashboard session).

2. **Register the device** against that employee, via
   `POST /v1/dashboard/employees/devices`:

   ```json
   {
     "employeeId": "<employee-uuid>",
     "machineId": "<Windows MachineGuid — HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid>",
     "hostname": "<hostname>",
     "os": "Windows 11 Pro",
     "agentVersion": "0.1.0"
   }
   ```

   The response includes `rawApiKey` **exactly once** — it is never recoverable after this call
   (only its HMAC is stored). Copy it immediately.

3. **Provision the key onto the device.** The Agent looks for it in a machine-scoped environment
   variable, `WORKFORCEAGENT_DEVICE_API_KEY`, the first time it starts without a stored
   credential (`Agent.Core.Identity.DeviceEnrollmentBootstrapper`). Set it via your deployment
   tooling (Intune, SCCM, GPO Preferences, or a provisioning script run as part of installing the
   Agent), e.g.:

   ```powershell
   [Environment]::SetEnvironmentVariable('WORKFORCEAGENT_DEVICE_API_KEY', '<rawApiKey>', 'Machine')
   ```

   On next start, the Agent imports the key into a DPAPI-protected local store
   (`C:\ProgramData\WorkforceAgent\keys\device.key`, LocalMachine scope — readable only by that
   machine, matching the SQLite database key's existing protection pattern) and uses it for every
   subsequent request via `Agent.Sync.DeviceAuthDelegatingHandler`. The environment variable does
   not need to be removed afterward — it's simply ignored once a credential is already stored —
   but clearing it after confirming enrollment succeeded avoids leaving a live secret in machine
   environment state.

4. **Confirm.** Check the Agent's log (`C:\ProgramData\WorkforceAgent\logs\agent-*.log` /
   `tray-*.log`) for `"Device enrolled successfully"`. If instead you see `"This device is not
   enrolled"`, the environment variable wasn't set (or the process needs restarting to pick it
   up — environment variable changes are not visible to already-running processes).

## Rotation / revocation

- **Revoke**: `PATCH /v1/dashboard/employees/devices/:deviceId/status` with `{ "isActive": false
  }`. The device will start receiving `403 Forbidden` (distinct from `401`, so a security engineer
  reading logs can tell "deactivated" apart from "never enrolled / wrong key").
- **Rotate**: there is currently no rotate-in-place endpoint. Re-registering the same
  `machineId` is rejected (`400 A device with this machineId is already registered`); rotation
  requires deactivating the old device row and registering a new one, then re-provisioning the
  environment variable and clearing the local `device.key` file so the Agent re-imports the new
  key on next start. Automating in-place key rotation is a reasonable follow-up if devices need
  to rotate credentials on a schedule rather than only on suspected compromise.
