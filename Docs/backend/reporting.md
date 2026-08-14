# Reporting - the dashboard read path

Everything under `/v1/dashboard/reports/*`. Source: `Backend/src/modules/report/`.

| File | Responsibility |
|---|---|
| `report.routes.ts` | Route table with `requireRole` and `auditLogger` on every entry |
| `reportController.ts` | Query-parameter parsing, response shaping |
| `reportService.ts` | The queries |
| `pagination.ts` | Keyset cursors, page-size resolution |
| `categoryService.ts` | App/domain -> productivity tag matching |
| `activityClassification.ts` | Which `ActivityType` values count as active vs idle |

---

## 1. Two kinds of query, and they must not be confused

**This is the rule that keeps the read path from degrading as history accumulates.**

| | Aggregates | Logs |
|---|---|---|
| Endpoints | overview, roster, employee totals | timeline, alerts, USB, screenshots |
| Reads | `daily_activity_rollups` | The raw tables |
| Bound | One row per employee per day | One keyset page |
| Cost as history grows | Flat | Flat |

Aggregates **never touch the log tables**. One indexed `GROUP BY` over at most
(employees x days) rows - 100 employees over a month is ~3,000 rows, and that ceiling does not
move as telemetry accumulates.

The version this replaced grouped `activity_sessions` instead: the same answer computed from
millions of ten-second app switches on every page load, degrading with **history** rather than
headcount, so it got worse forever and could not be fixed by adding capacity.

**No endpoint here returns "everything in the range."** If you are adding one that would, you are
adding the problem back.

## 2. Keyset pagination

Cursor = `(timestamp, id)`, encoded as `<ISO timestamp>|<uuid>`, newest first.

```
olderThan(field, cursor) ->
  OR: [ { field: { lt: cursor.timestamp } },
        { field: cursor.timestamp, id: { lt: cursor.id } } ]
```

Expressed as an `OR` because Prisma has no row-value comparison. Postgres still uses the
timestamp index for the first branch, and the second only ever matches within one timestamp.

**The id is in the key because timestamps collide** - an agent can close several app sessions in
the same millisecond, and a cursor on a non-unique key either loses the tied rows or repeats them
forever.

Pages **over-fetch by one row** to answer `hasMore` without a second `COUNT` over the same
predicate, which on a log table costs as much as the page itself. The extra row is never returned.

`decodeCursor` returns `null` for anything malformed rather than throwing - a truncated URL or a
stale bookmark should serve the first page, not a 500.

`newestFirst(field)` and `olderThan(field, ...)` **must always change together.**

### Page sizes

| Setting | Policy field | Default | Hard ceiling |
|---|---|---|---|
| Log feeds | `logPageSize` | 50 | 500 |
| Screenshot gallery | `screenshotPageSize` | 12 | 60 |

Read from policy so an admin can change them without a redeploy, and clamped so a bad value
cannot turn one scroll into an unbounded read. A caller may request **fewer**, never more.

They are separate settings on purpose (AD-13): a page of log rows is a few kilobytes of JSON, a
page of screenshots is that many full-size JPEGs the browser downloads and decodes.

The fallbacks when an organization has no policy row (`PAGE_SIZE_DEFAULT`,
`SCREENSHOT_PAGE_SIZE_DEFAULT`) match the schema defaults, so the two cannot drift into
disagreeing about what "a page" means.

## 3. The endpoints

| Endpoint | Reads | Notes |
|---|---|---|
| `GET /overview` | Rollup | Team totals, productivity, who is online, attendance |
| `GET /roster` | Rollup | All staff with active/idle/productivity at a glance |
| `GET /employees/:id` | Rollup + one page | Totals, active/idle split, top apps and domains, first timeline page |
| `GET /employees/:id/activity` | Raw, keyset | Timeline pages behind the scroll window |
| `GET /alerts` | Raw, keyset | `includeResolved` filter |
| `GET /usb-events` | Raw, keyset | Audit trail |
| `GET /employees/:id/screenshots` | Raw, keyset | Index only, never bytes |
| `GET /screenshots/:deviceId/:file` | Filesystem | One image, audited individually |

The employee detail endpoint and the activity feed are separate so that scrolling fetches **rows
only**, not the totals and leaderboards that do not change between pages.

Browser visits are attached to the app session that contained them, so the UI can expand a
"Chrome - 2h" row into the sites that made it up - fetched for the rows on *this page* only.

Top-app and top-domain lists are a fixed leaderboard, not a page.

## 4. "Online now"

Derived from `devices.lastSeen`, which only an authenticated **HTTP** request updates - never
from Socket.IO presence.

The two answer different questions. A socket can stay open through a total backend failure, and
can be closed while an agent syncs happily over HTTP. `lastSeen` means "this device successfully
authenticated to this server recently"; socket presence means "a command sent right now would
reach it". The overview screen wants the first. See [realtime.md](realtime.md) for the second.

## 5. Role gates

Every route carries `requireRole` and `auditLogger`. The audit entry is written for **reads**,
not just writes - who looked at whom is the point.

| Role | Reports | Screenshots |
|---|---|---|
| `super_admin` | Yes | Yes |
| `manager` | Yes | Yes |
| `auditor` | Yes | **No** |

Auditor exclusion from screenshots is deliberate and structural (AD-12): aggregate reports and
the audit log, never a picture of someone's desktop. It applies to both the index and the image.

## 6. Productivity classification

`categoryService` matches an app name, process name, executable path or domain against the
organization's `Category` rules, case-insensitively, and returns a `ProductivityTag`.
`activityClassification` decides which `ActivityType` values count as active versus idle.

Productive share is `productiveSeconds / activeSeconds`, 0-100. **Idle time is excluded from the
denominator** - otherwise a long lunch would read as unproductive work rather than as no work.

Categories also drive blacklist alerts, via `isBlacklisted`.

---

## Failure modes

| Symptom | Likely cause | Check |
|---|---|---|
| Overview slow, worsening over months | An aggregate query reading a log table | Look for `activity_sessions` in an aggregate method |
| A page repeats or skips rows | `newestFirst` and `olderThan` disagree on the field | Both must name the same column |
| Scrolling stops early | `hasMore` false because over-fetch was dropped | Caller must ask for `limit + 1` |
| Employee shows zero, device is online | Device on the "Unassigned" placeholder | Devices screen |
| Totals disagree with the timeline | Expected - the timeline is one page, totals are the range | Not a bug |
| Auditor gets 403 on screenshots | Working as designed (AD-12) | - |

---

## Related

- [ingest.md](ingest.md) - what writes the rollup this reads
- [realtime.md](realtime.md) - how these screens update without a refresh
- [security.md](security.md) - roles and audit logging
- [../reference/dashboard-api.md](../reference/dashboard-api.md) - endpoint reference
- [../frontend/live-updates.md](../frontend/live-updates.md) - the consumer of these feeds
