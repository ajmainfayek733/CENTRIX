# Dashboard API reference

`/v1/dashboard/*` - the surface the Next.js dashboard calls. Read from
`Backend/src/modules/{auth,organization,employee,report}/*.routes.ts`.

**Authentication:** Better Auth session (cookie or `Authorization: Bearer <session token>`),
verified by `userAuth`. Authenticated dashboard routes carry `requireRole(...)` and
`auditLogger(...)`. Public exceptions: login, password recovery, and organization registration.

**Envelope:** every response is

```json
{ "status": "success", "message": "...", "data": <payload> }
```

`apiGet`/`apiSend` in `Frontend/src/lib/api-client.ts` unwrap `.data`. A handler returning a bare
object gives the dashboard `undefined` rather than an error.

Errors: `{ "status": "error", "message": "..." }` with 400, 401, 403, 404 or 500.

Roles: `A` = `super_admin`, `M` = `manager`, `U` = `auditor`.

---

## Auth - `/v1/dashboard/auth`

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/register` | - | Rate limited 10/min per IP |
| POST | `/login` | - | Rate limited 10/min per IP |
| POST | `/forgot-password` | - | Rate limited 5 / 15 min per IP. Emails a reset link and/or code via EmailJS. Same response for every email: `{ delivery, expiresInMinutes }`, never a secret. 503 when email is not configured in production. See [password-recovery.md](../backend/password-recovery.md). |
| POST | `/reset-password` | - | Rate limited 5 / 15 min per IP. Body: `email`, `token` (link token or code), `newPassword`. Revokes the recovery after `PASSWORD_RESET_MAX_ATTEMPTS` failures. Invalidates existing sessions. |
| GET | `/me` | Any session | Role comes from the server every request - a revoked session takes effect immediately |
| POST | `/realtime-ticket` | Any session | Mints a short-lived signed socket ticket |

Better Auth's own endpoints are mounted separately at `/api/auth/*` and **must** be registered
before `express.json()`.

## Organizations - `/v1/dashboard/organizations`

| Method | Path | Roles | Audit action |
|---|---|---|---|
| POST | `/register` | - | Public onboarding. Creates org, default policy, first `super_admin`, and enrollment token. Rate limited 5 / 15 min per IP. |
| GET | `/` | A M U | `VIEW_ALL_ORGANIZATIONS` |
| GET | `/:id` | A M U | `VIEW_ORGANIZATION_DETAIL` |
| POST | `/` | A | `CREATE_ORGANIZATION` |
| POST | `/:id/enrollment-token` | A | `ROTATE_ENROLLMENT_TOKEN` |
| GET | `/:id/policy` | A M U | `VIEW_POLICY` |
| PATCH | `/:id/policy` | A | `UPDATE_POLICY` |
| GET | `/:id/categories` | A M U | `VIEW_CATEGORIES` |
| PUT | `/:id/categories` | A | `UPSERT_CATEGORY` |
| DELETE | `/:id/categories/:categoryId` | A | `DELETE_CATEGORY` |

`POST /` and `POST /register` return the enrollment token **once**; only its HMAC is persisted.
The token is required in the Windows agent installer to register organization devices.

`POST /:id/enrollment-token` rotates it. Already-issued device keys keep working, but every
`agent.config.json` in the fleet now holds a stale token - see
[../operations/agent-deployment.md](../operations/agent-deployment.md) section 4.

`PATCH /:id/policy` increments `version`, which triggers a policy fetch and a fresh consent prompt
on every agent.

## Employees and devices - `/v1/dashboard/employees`

| Method | Path | Roles | Audit action |
|---|---|---|---|
| GET | `/` | A M U | `VIEW_ALL_EMPLOYEES` |
| GET | `/:id` | A M U | `VIEW_EMPLOYEE_DETAIL` |
| POST | `/` | A | `CREATE_EMPLOYEE` |
| POST | `/bulk` | A | `BULK_CREATE_EMPLOYEES` |
| PATCH | `/:id` | A | `UPDATE_EMPLOYEE` |
| GET | `/devices` | A M U | `VIEW_DEVICE_INVENTORY` |
| PATCH | `/devices/:deviceId/assignment` | A | `ASSIGN_DEVICE` |
| PATCH | `/devices/:deviceId/status` | A | `SET_DEVICE_STATUS` |

`POST /bulk` backs the roster import: `name, email, department` per line, tab-separated
spreadsheet paste works, a header row is ignored, and existing people are skipped rather than
failing the import.

`PATCH /devices/:deviceId/assignment` moves a device off the "Unassigned Devices" placeholder.
**Until this is done its telemetry is stored but reaches no per-employee report.**

`PATCH /devices/:deviceId/status` is the kill switch. A deactivated device gets 403 on every
authenticated route, on the socket handshake, and at re-enrollment - so reinstalling is not a way
around it. It also emits `device:deactivated` so the agent stops pushing without waiting for a 403.

## Reports - `/v1/dashboard/reports`

| Method | Path | Roles | Reads | Audit action |
|---|---|---|---|---|
| GET | `/overview` | A M U | Rollup | `VIEW_OVERVIEW` |
| GET | `/roster` | A M U | Rollup | `VIEW_EMPLOYEE_ROSTER` |
| GET | `/attendance` | A M U | Rollup + today | `VIEW_TEAM_ATTENDANCE` |
| GET | `/employees/:employeeId` | A M U | Rollup + page | `VIEW_EMPLOYEE_DETAIL_REPORT` |
| GET | `/employees/:employeeId/pdf` | A M U | Same as detail | `EXPORT_EMPLOYEE_PDF_REPORT` |
| GET | `/departments/:departmentId` | A M U | Rollup + sessions | `VIEW_DEPARTMENT_DETAIL_REPORT` |
| GET | `/departments/:departmentId/pdf` | A M U | Same as detail | `EXPORT_DEPARTMENT_PDF_REPORT` |
| GET | `/departments/:departmentId/batch-zip` | A M U | Detail + member PDFs | `EXPORT_DEPARTMENT_BATCH_ZIP` |
| GET | `/employees/:employeeId/activity` | A M U | Keyset | `VIEW_EMPLOYEE_ACTIVITY_LOG` |
| GET | `/alerts` | A M U | Keyset | `VIEW_ALERTS` |
| GET | `/usb-events` | A M U | Keyset | `VIEW_USB_EVENTS` |
| GET | `/employees/:employeeId/usb-events` | A M U | Keyset | `VIEW_EMPLOYEE_USB_EVENTS` |
| GET | `/employees/:employeeId/screenshots` | **A M** | Keyset | `VIEW_SCREENSHOT_INDEX` |
| GET | `/screenshots/:deviceId/:file` | **A M** | Filesystem | `VIEW_SCREENSHOT` |

**Auditors are excluded from both screenshot routes** - the index and the image. See
[../architecture/decisions.md](../architecture/decisions.md) AD-12.

### Query parameters

| Parameter | Applies to | Notes |
|---|---|---|
| `startDate`, `endDate` | Aggregates and feeds | `YYYY-MM-DD`. Defaults to today for employee detail |
| `cursor` | Keyset feeds | Opaque `<ISO timestamp>\|<uuid>`. Malformed serves the first page |
| `limit` | Keyset feeds | May request **fewer** than policy allows, never more |
| `includeResolved` | `/alerts` | |

### Paged response shape

```json
{ "rows": [ ... ], "nextCursor": "2026-08-14T09:00:00.000Z|<uuid>", "hasMore": true }
```

`nextCursor` is `null` when the feed is exhausted. Pages over-fetch by one row to answer `hasMore`
without a second `COUNT`; the extra row is never returned.

Page sizes come from policy: `logPageSize` (50, ceiling 500) and `screenshotPageSize`
(12, ceiling 60).

---

## The frontend's own routes

Not part of this API - same-origin Next.js handlers that attach the session server-side.

| Route | Proxies to |
|---|---|
| `POST /api/auth/login` | `/v1/dashboard/auth/login`, sets the httpOnly cookie |
| `POST /api/auth/forgot-password` | `/v1/dashboard/auth/forgot-password` |
| `POST /api/auth/reset-password` | `/v1/dashboard/auth/reset-password` |
| `POST /api/auth/register-organization` | `/v1/dashboard/organizations/register` |
| `POST /api/auth/logout` | Clears the cookie |
| `GET /api/logs/[feed]` | `activity`, `alerts`, `usb`, `screenshots` - **allowlisted**, 404 otherwise |
| `POST /api/realtime/ticket` | `/v1/dashboard/auth/realtime-ticket` |
| `GET /api/screenshots/[deviceId]/[file]` | The image bytes |
| `GET /api/reports/employees/[employeeId]/pdf` | Employee PDF stream |
| `GET /api/reports/departments/[departmentId]/pdf` | Department performance PDF |
| `GET /api/reports/departments/[departmentId]/batch-zip` | Department PDF bundle |

`/api/logs/[feed]` forwards only `cursor`, `limit`, `startDate`, `endDate`, `includeResolved`;
anything else is dropped. It answers **503** when the monitoring service is unreachable and 502 for
other failures - the distinction is what makes the scroll window's retry worth taking.

See [../frontend/session-and-auth.md](../frontend/session-and-auth.md).

---

## Related

- [../backend/reporting.md](../backend/reporting.md) - how these queries work
- [../backend/security.md](../backend/security.md) - roles and audit
- [../frontend/README.md](../frontend/README.md) - the consumer
- [agent-api.md](agent-api.md) - the other surface
