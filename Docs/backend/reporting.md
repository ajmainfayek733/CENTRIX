# Reporting - the dashboard read path

Everything under `/v1/dashboard/reports/*`. Source: `Backend/src/modules/report/`.

| File                        | Responsibility                                                  |
| --------------------------- | --------------------------------------------------------------- |
| `report.routes.ts`          | Route table with `requireRole` and `auditLogger` on every entry |
| `reportController.ts`       | Query-parameter parsing, response shaping                       |
| `reportService.ts`          | The queries                                                     |
| `pagination.ts`             | Keyset cursors, page-size resolution                            |
| `categoryService.ts`        | App/domain -> productivity tag matching                         |
| `activityClassification.ts` | Which `ActivityType` values count as active vs idle             |

---

## 1. Two kinds of query, and they must not be confused

**This is the rule that keeps the read path from degrading as history accumulates.**

|                       | Aggregates                                          | Logs                               |
| --------------------- | --------------------------------------------------- | ---------------------------------- |
| Endpoints             | overview, roster, employee totals                   | timeline, alerts, USB, screenshots |
| Reads                 | `daily_activity_rollups`, `browser_daily_summaries` | The raw tables                     |
| Bound                 | One row per employee per day                        | One keyset page                    |
| Cost as history grows | Flat                                                | Flat                               |

Aggregates **never touch the log tables**. One indexed `GROUP BY` over at most
(employees x days) rows - 100 employees over a month is ~3,000 rows, and that ceiling does not
move as telemetry accumulates.

Browser top-domain reports read `browser_daily_summaries`, one row per employee, work date and
domain. The row stores duration by productivity bucket so a domain remains a single row even when
its classification changes during the day.

Employee detail uses a hybrid rule: a one-day audit reads raw `browser_activity`; a multi-day
range reads raw rows for today and daily summaries for completed days. The response is normalized
to the existing `topDomains` shape, so the frontend does not need to know which storage tier was
used.

### Historical backfill

When `browser_daily_summaries` is empty after deployment, rebuild completed dates with:

```bash
npm run aggregate:browser
```

The command excludes today by default. Limit a rerun with `--from=YYYY-MM-DD` and
`--to=YYYY-MM-DD`, or target one organization with `--organization-id=<id>`.

Activity metric samples use the same backfill script and produce one row per employee and work
date in `activity_metric_daily_summaries`:

```bash
npm run aggregate:activity-metrics -- --from=2026-09-01 --to=2026-09-18
```

Application sessions use one row per employee, work date and application in
`activity_session_daily_summaries`:

```bash
npm run aggregate:activity-sessions -- --from=2026-09-01 --to=2026-09-18
```

The version this replaced grouped `activity_sessions` instead: the same answer computed from
millions of ten-second app switches on every page load, degrading with **history** rather than
headcount, so it got worse forever and could not be fixed by adding capacity.

**No endpoint here returns "everything in the range."** If you are adding one that would, you are
adding the problem back.

### The range itself

`?startDate=&endDate=` resolve through `resolveRange`. **A date-only `endDate` is inclusive of the
day it names** - it is snapped to `23:59:59.999Z`, because `new Date('2026-08-15')` is midnight at
the _start_ of the 15th and taking that literally makes `startDate=endDate` a zero-width window.
That is what the "Today" preset sends, and the failure was invisible in the worst way: totals still
rendered, because they read the rollup through `startOfUtcDay` on both bounds, while attendance,
sessions and the timeline came back empty on a day full of activity.

An `endDate` carrying a time component is left exactly as given - a caller that asked for an
instant is not silently widened by up to a day. `startDate` needs no equivalent, since midnight at
the start of a day is already the inclusive lower bound.

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

| Setting            | Policy field         | Default | Hard ceiling |
| ------------------ | -------------------- | ------- | ------------ |
| Log feeds          | `logPageSize`        | 50      | 500          |
| Screenshot gallery | `screenshotPageSize` | 12      | 60           |

Read from policy so an admin can change them without a redeploy, and clamped so a bad value
cannot turn one scroll into an unbounded read. A caller may request **fewer**, never more.

They are separate settings on purpose (AD-13): a page of log rows is a few kilobytes of JSON, a
page of screenshots is that many full-size JPEGs the browser downloads and decodes.

The fallbacks when an organization has no policy row (`PAGE_SIZE_DEFAULT`,
`SCREENSHOT_PAGE_SIZE_DEFAULT`) match the schema defaults, so the two cannot drift into
disagreeing about what "a page" means.

## 3. The endpoints

| Endpoint                           | Reads             | Notes                                                                                                  |
| ---------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /overview`                    | Rollup            | Team totals, productivity, who is online, attendance                                                   |
| `GET /roster`                      | Rollup            | All staff with active/idle/productivity at a glance                                                    |
| `GET /employees/:id`               | Rollup + one page | Totals, active/idle split, top apps and domains, first timeline page, attendance by day and by session |
| `GET /employees/:id/activity`      | Raw, keyset       | Timeline pages behind the scroll window                                                                |
| `GET /alerts`                      | Raw, keyset       | `includeResolved` filter                                                                               |
| `GET /usb-events`                  | Raw, keyset       | Audit trail, org-wide                                                                                  |
| `GET /employees/:id/usb-events`    | Raw, keyset       | The same trail, one employee's machines                                                                |
| `GET /employees/:id/screenshots`   | Raw, keyset       | Index only, never bytes                                                                                |
| `GET /screenshots/:deviceId/:file` | Filesystem        | One image, audited individually                                                                        |

The employee detail endpoint and the activity feed are separate so that scrolling fetches **rows
only**, not the totals and leaderboards that do not change between pages.

Browser visits are attached to the app session that contained them, so the UI can expand a
"Chrome - 2h" row into the sites that made it up - fetched for the rows on _this page_ only.

Top-app and top-domain lists are a fixed leaderboard, not a page.

## 3.1 Attendance, by day and by session

`GET /employees/:id` returns attendance twice, because two different questions are asked of it.

`attendance` is the raw sessions - one per uninterrupted stretch of presence, since a lock, a
suspend or a logoff ends one and coming back starts another. It answers "when did they step away,
and what ended each stretch".

`attendanceDays` folds those into **one row per work date**, which is the attendance report proper:

| Field                           | Where it comes from                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `firstLogin` / `lastLogout`     | Earliest and latest across that date's sessions. `lastLogout` is null while a session is still open. |
| `sessionSeconds`                | First login to last logout - or to _now_ while the day is still running.                             |
| `activeSeconds` / `idleSeconds` | The **daily rollup**, not the attendance rows.                                                       |
| `sessionCount`                  | How many stretches of presence made up the day.                                                      |
| `status`                        | `present`, `ended`, or `unknown`.                                                                    |
| `logoutEstimated`               | Whether `lastLogout` was inferred by the server rather than observed.                                |

Three things here are deliberate and easy to get wrong.

**The seconds come from the rollup, not from summing the attendance rows.** The rollup counts the
activity log, which includes the locked and suspended stretches _between_ sessions; an attendance
row deliberately counts only the presence inside itself. Adding the rows up reports a day with a
lunch break as shorter than it was. It also follows that `sessionSeconds` can exceed
`activeSeconds + idleSeconds` - time when the workstation was off was observed by nobody and is
credited to nobody.

**`status` is not just "is `lastLogout` null".** An open row means the agent had not observed a
logout when it last wrote, which is also what a machine that lost power leaves behind. `present`
therefore requires the owning device to have been seen inside the "online now" window; an open
session on a device that has gone quiet is `unknown`, and its day is measured to the last activity
the rollup saw rather than to a logout that was never observed. Without that test the dashboard
shows yesterday's crash as somebody still at their desk.

**A logout can be an estimate, and the report says which.** When a workstation stops answering
without recording an end, the backend closes the session itself from the last evidence it holds
(`logoutSource = Server` - see [ingest.md](ingest.md) section 9). `attendance[].logoutSource`
carries that per session and `attendanceDays[].logoutEstimated` says whether the day's _last_
logout is one - assigned from whichever session supplies it, not OR-ed across the day, because an
estimate at lunchtime says nothing about the time the day ended on. The UI marks both. These
numbers reach payroll, and an approximate figure presented as a recorded clock-out is worse than
one labelled approximate.

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

| Role          | Reports | Screenshots |
| ------------- | ------- | ----------- |
| `super_admin` | Yes     | Yes         |
| `manager`     | Yes     | Yes         |
| `auditor`     | Yes     | **No**      |

Auditor exclusion from screenshots is deliberate and structural (AD-12): aggregate reports and
the audit log, never a picture of someone's desktop. It applies to both the index and the image.

## 6. Productivity classification

`categoryService` matches an app name, process name, executable path or domain against the
organization's `Category` rules, case-insensitively, and returns a `ProductivityTag`.
`activityClassification` decides which `ActivityType` values count as active versus idle.

Productive share is `productiveSeconds / activeSeconds`, 0-100. **Idle time is excluded from the
denominator** - otherwise a long lunch would read as unproductive work rather than as no work.

Categories also drive blacklist alerts, via `isBlacklisted`.

## 7. Browser domain productivity inheritance

Browser applications (Google Chrome, Microsoft Edge, Firefox, Brave, etc.) are frequently classified as `Productive` or `Neutral` at the container application level. However, actual browsing activities within those applications target specific domains with their own productivity classifications (e.g. `youtube.com` as `Unproductive`, `facebook.com` as `Blacklisted`).

To ensure accurate reporting:
- `ReportService.getApplicationGroups` identifies browser applications and apportions domain-level productive, unproductive, blacklisted, and neutral seconds into the container browser app breakdown. Any unassigned browser time retains the container's base classification.
- `ReportService.totalsByEmployee` adjusts overall employee totals (`productiveSeconds`, `unproductiveSeconds`, `blacklistedSeconds`, `neutralSeconds`) so that unproductive and blacklisted time spent on web domains is directly reflected in the Activity Mix totals and productivity percentage, preserving `activeSeconds` invariance.
- `ReportService.summarizeAttendance` guarantees all dates with active telemetry in `dailyTotals` are included in `attendanceDays`.

---

## Failure modes

| Symptom                                             | Likely cause                                              | Check                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Overview slow, worsening over months                | An aggregate query reading a log table                    | Look for `activity_sessions` in an aggregate method                                                               |
| A page repeats or skips rows                        | `newestFirst` and `olderThan` disagree on the field       | Both must name the same column                                                                                    |
| Scrolling stops early                               | `hasMore` false because over-fetch was dropped            | Caller must ask for `limit + 1`                                                                                   |
| Employee shows zero, device is online               | Device on the "Unassigned" placeholder                    | Devices screen                                                                                                    |
| Totals disagree with the timeline                   | Expected - the timeline is one page, totals are the range | Not a bug                                                                                                         |
| Totals render but attendance and timeline are empty | The range resolved to a zero-width window                 | `period` in the response - if `start` equals `end`, `resolveRange` did not snap a date-only `endDate` (section 1) |
| Auditor gets 403 on screenshots                     | Working as designed (AD-12)                               | -                                                                                                                 |

---

## Related

- [ingest.md](ingest.md) - what writes the rollup this reads
- [realtime.md](realtime.md) - how these screens update without a refresh
- [security.md](security.md) - roles and audit logging
- [../reference/dashboard-api.md](../reference/dashboard-api.md) - endpoint reference
- [../frontend/live-updates.md](../frontend/live-updates.md) - the consumer of these feeds
