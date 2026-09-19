import Link from "next/link";
import { notFound } from "next/navigation";
import { apiGet, ApiError } from "@/lib/api-client";
import { formatDuration, formatPercent, formatTime } from "@/lib/format";
import { ArrowLeft } from "lucide-react";
import {
  Card,
  PageHeader,
  StatTile,
  HeroPercent,
  Legend,
  TableWrap,
  TABLE_CLASS,
  Th,
  Td,
  TagBadge,
  Badge,
  EmptyState,
  ProductivityBar,
} from "@/components/ui";
import type { EmployeeDetail, ScreenshotRow, UsbEventRow } from "@/types/api";
import type { LogPage } from "@/lib/use-log-feed";
import { getSessionUser, canViewScreenshots } from "@/lib/session";
import { DateRangePicker } from "@/components/DateRangePicker";
import { ScreenshotGallery } from "@/components/ScreenshotGallery";
import { TimelineTable } from "./TimelineTable";
import { EmployeeUsbTable } from "./EmployeeUsbTable";
import { WeeklyAttendance } from "./WeeklyAttendance";

export const metadata = { title: "Employee - C E N T R I X" };
export const dynamic = "force-dynamic";

export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ employeeId: string }>;
  searchParams: Promise<{ startDate?: string; endDate?: string }>;
}) {
  const { employeeId } = await params;
  const range = await searchParams;

  const query = new URLSearchParams();
  if (range.startDate) query.set("startDate", range.startDate);
  if (range.endDate) query.set("endDate", range.endDate);
  const suffix = query.size > 0 ? `?${query}` : "";

  let detail: EmployeeDetail;
  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    [detail, user] = await Promise.all([
      apiGet<EmployeeDetail>(`/v1/dashboard/reports/employees/${employeeId}${suffix}`),
      getSessionUser(),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const { employee, period, totals, timeline, topApps, topDomains, attendance, attendanceDays } =
    detail;
  const { startDate, endDate } = range;
  console.log("Employee Data", detail, range);

  /*
    Screenshots are the most invasive surface in the product and the Auditor role is excluded from
    them by spec section 6. The gate is here as well as on the API because a section that renders and then
    fails to load its images is worse than one that was never offered - and asking for the first
    page at all would just earn a 403. The API remains the enforcement point; this is the UI
    agreeing with it.
  */
  /*
    Fetched in parallel: neither depends on the other, and awaiting them in sequence would put
    two round trips on the critical path of a screen that has already made one.

    The USB trail needs no role gate of its own. Its endpoint admits the same three roles that
    can reach this page at all, unlike screenshots - so gating it here would only hide a section
    from people the API is willing to answer.
  */
  const [usbEvents, screenshots] = await Promise.all([
    apiGet<LogPage<UsbEventRow>>(
      `/v1/dashboard/reports/employees/${employeeId}/usb-events${suffix}`,
    ),
    user && canViewScreenshots(user.role)
      ? apiGet<LogPage<ScreenshotRow>>(
          `/v1/dashboard/reports/employees/${employeeId}/screenshots${suffix}`,
        )
      : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-3.5">
      <PageHeader
        title={employee.name}
        subtitle={`${employee.email}${employee.department ? ` - ${employee.department}` : ""}`}
        back={
          <Link
            href="/employees"
            className="mb-2.5 inline-flex items-center gap-1.5 text-[13px] text-text-secondary transition-colors hover:text-brand"
          >
            <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden />
            Back to employees
          </Link>
        }
        action={<DateRangePicker startDate={range.startDate} endDate={range.endDate} />}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Active" value={formatDuration(totals.activeSeconds)} />
        <StatTile label="Idle" value={formatDuration(totals.idleSeconds)} />
        <StatTile
          label="Blacklisted"
          value={formatDuration(totals.blacklistedSeconds)}
          tone={totals.blacklistedSeconds > 0 ? "danger" : "default"}
        />
      </div>

      {/*
        Productive time and the mix it comes from are one card, not two. Split across a tile and
        a bare bar, the percentage was a number with nothing to read it against and the bar was a
        shape with no figure on it - each was the other's missing half.
      */}
      <Card title="Productivity mix">
        <HeroPercent
          value={formatPercent(totals.productivityPercent)}
          caption="of active time tagged productive"
        />

        <div className="my-3.5">
          <ProductivityBar
            productive={totals.productiveSeconds}
            unproductive={totals.unproductiveSeconds}
            neutral={totals.neutralSeconds}
            blacklisted={totals.blacklistedSeconds}
          />
        </div>

        <Legend
          items={[
            {
              key: "productive",
              label: "Productive",
              value: formatDuration(totals.productiveSeconds),
            },
            { key: "neutral", label: "Neutral", value: formatDuration(totals.neutralSeconds) },
            {
              key: "unproductive",
              label: "Unproductive",
              value: formatDuration(totals.unproductiveSeconds),
            },
            {
              key: "blacklisted",
              label: "Blacklisted",
              value: formatDuration(totals.blacklistedSeconds),
            },
            { key: "idle", label: "Idle", value: formatDuration(totals.idleSeconds) },
          ]}
        />
      </Card>

      {/*
        The week strip sits directly under the mix because the two are read together: the mix says
        how the time was spent, this says which days it was spent on. Both are folded from data the
        page already holds, so neither costs a request.
      */}
      <Card title="Weekly attendance">
        <WeeklyAttendance
          attendanceDays={attendanceDays}
          periodStart={period.start}
          periodEnd={period.end}
        />
      </Card>

      <div className="grid gap-3.5 lg:grid-cols-2">
        <Card title="Top applications">
          {topApps.length === 0 ? (
            <EmptyState message="No application time recorded in this period." />
          ) : (
            <ul className="-my-2 divide-y divide-border">
              {topApps.map((app) => (
                <li
                  key={`${app.appName}-${app.productivityTag}`}
                  className="flex items-start justify-between gap-4 py-2.5 text-[13.5px]"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-text-primary">
                        {app.appName ?? "Unknown"}
                      </span>
                      <TagBadge tag={app.productivityTag} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-text-secondary">
                      {app.productiveSeconds > 0 && (
                        <span className="inline-flex items-center gap-1.5" title="Productive">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-success-vivid" aria-hidden />
                          <span className="tnum font-medium text-text-primary">{formatDuration(app.productiveSeconds)}</span>
                          <span className="text-text-muted">Productive</span>
                        </span>
                      )}
                      {app.neutralSeconds > 0 && (
                        <span className="inline-flex items-center gap-1.5" title="Neutral">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-dot" aria-hidden />
                          <span className="tnum font-medium text-text-primary">{formatDuration(app.neutralSeconds)}</span>
                          <span className="text-text-muted">Neutral</span>
                        </span>
                      )}
                      {app.unproductiveSeconds > 0 && (
                        <span className="inline-flex items-center gap-1.5" title="Unproductive">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-hidden />
                          <span className="tnum font-medium text-text-primary">{formatDuration(app.unproductiveSeconds)}</span>
                          <span className="text-text-muted">Unproductive</span>
                        </span>
                      )}
                      {app.blacklistedSeconds > 0 && (
                        <span className="inline-flex items-center gap-1.5" title="Blacklisted">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-danger" aria-hidden />
                          <span className="tnum font-medium text-danger">{formatDuration(app.blacklistedSeconds)}</span>
                          <span className="text-text-muted">Blacklisted</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="tnum block text-[13.5px] font-semibold text-text-primary">
                      {formatDuration(app.seconds)}
                    </span>
                    <span className="block text-[10.5px] uppercase tracking-wider text-text-muted">
                      Total
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Top websites">
          {topDomains.length === 0 ? (
            <EmptyState message="No browsing recorded in this period." />
          ) : (
            <ul className="-my-2 divide-y divide-border">
              {topDomains.map((site) => (
                <li
                  key={`${site.domain}-${site.productivityTag}`}
                  className="flex items-start justify-between gap-4 py-2.5 text-[13.5px]"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-text-primary">{site.domain}</span>
                      <TagBadge tag={site.productivityTag} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-text-secondary">
                      {site.productiveSeconds > 0 && (
                        <span className="inline-flex items-center gap-1.5" title="Productive">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-success-vivid" aria-hidden />
                          <span className="tnum font-medium text-text-primary">{formatDuration(site.productiveSeconds)}</span>
                          <span className="text-text-muted">Productive</span>
                        </span>
                      )}
                      {site.neutralSeconds > 0 && (
                        <span className="inline-flex items-center gap-1.5" title="Neutral">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-dot" aria-hidden />
                          <span className="tnum font-medium text-text-primary">{formatDuration(site.neutralSeconds)}</span>
                          <span className="text-text-muted">Neutral</span>
                        </span>
                      )}
                      {site.unproductiveSeconds > 0 && (
                        <span className="inline-flex items-center gap-1.5" title="Unproductive">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-hidden />
                          <span className="tnum font-medium text-text-primary">{formatDuration(site.unproductiveSeconds)}</span>
                          <span className="text-text-muted">Unproductive</span>
                        </span>
                      )}
                      {site.blacklistedSeconds > 0 && (
                        <span className="inline-flex items-center gap-1.5" title="Blacklisted">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-danger" aria-hidden />
                          <span className="tnum font-medium text-danger">{formatDuration(site.blacklistedSeconds)}</span>
                          <span className="text-text-muted">Blacklisted</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="tnum block text-[13.5px] font-semibold text-text-primary">
                      {formatDuration(site.seconds)}
                    </span>
                    <span className="block text-[10.5px] uppercase tracking-wider text-text-muted">
                      Total
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/*
        The attendance report proper: one row per work date. Session duration spans first login to
        last logout, so it can exceed active + idle - time when the workstation was off was observed
        by nobody and is credited to nobody, which is the difference between measuring presence and
        assuming it.
      */}
      <Card title="Attendance">
        {attendanceDays.length === 0 ? (
          <EmptyState message="No sign-in recorded in this period." />
        ) : (
          <TableWrap>
            {/*
              This table puts a right-aligned number (Idle) straight before a left-aligned badge
              (Status), which used to need a hand-rolled column gutter to stop the two reading as
              one column. Td now carries that padding itself, so the override is gone.
            */}
            <table className={`${TABLE_CLASS} min-w-[720px]`}>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>First login</Th>
                  <Th>Last logout</Th>
                  <Th align="right">Session</Th>
                  <Th align="right">Active</Th>
                  <Th align="right">Idle</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {attendanceDays.map((day) => (
                  <tr key={day.workDate}>
                    <Td>{new Date(day.workDate).toLocaleDateString()}</Td>
                    <Td numeric>{formatTime(day.firstLogin)}</Td>
                    {/*
                      An estimated logout is marked on the value itself rather than in Status,
                      because it is the time that is approximate and not the fact that the day
                      ended. The workstation stopped answering without recording a logout - power
                      loss, most often - so the backend closed the session at the last evidence it
                      held. Reading it as a recorded clock-out is the mistake this prevents.
                    */}
                    <Td numeric>
                      {day.status === "present" ? (
                        "-"
                      ) : day.lastLogout && day.logoutEstimated ? (
                        <span
                          className="inline-flex items-center gap-1.5"
                          title="Estimated - the workstation stopped reporting without recording a logout, so this is the last activity seen"
                        >
                          {formatTime(day.lastLogout)}
                          <Badge tone="warning">Estimated</Badge>
                        </span>
                      ) : (
                        formatTime(day.lastLogout)
                      )}
                    </Td>
                    <Td align="right" numeric>
                      {formatDuration(day.sessionSeconds)}
                    </Td>
                    <Td align="right" numeric>
                      {formatDuration(day.activeSeconds)}
                    </Td>
                    <Td align="right" numeric>
                      {formatDuration(day.idleSeconds)}
                    </Td>
                    <Td>
                      {day.status === "present" ? (
                        <Badge tone="success">Present</Badge>
                      ) : day.status === "unknown" ? (
                        // An open session on a workstation that stopped reporting. Saying "present"
                        // here would show a crashed machine as somebody at their desk.
                        <Badge tone="warning">No logout recorded</Badge>
                      ) : (
                        <Badge>Signed out</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {/*
        The sessions the days above are folded from. Kept because "when did they actually step
        away" is a different question from "when did they arrive and leave", and the end reason -
        lock, sleep, shutdown - is only meaningful per session.
      */}
      <Card title="Attendance sessions">
        {attendance.length === 0 ? (
          <EmptyState message="No sign-in recorded in this period." />
        ) : (
          <TableWrap>
            <table className={`${TABLE_CLASS} min-w-[480px]`}>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Signed in</Th>
                  <Th>Signed out</Th>
                  <Th>Ended by</Th>
                </tr>
              </thead>
              <tbody>
                {attendance.map((row) => (
                  <tr key={row.sessionId}>
                    <Td>{new Date(row.workDate).toLocaleDateString()}</Td>
                    <Td numeric>{formatTime(row.loginTime)}</Td>
                    <Td numeric>
                      {row.logoutTime ? (
                        formatTime(row.logoutTime)
                      ) : (
                        <Badge tone="success">Still signed in</Badge>
                      )}
                    </Td>
                    {/*
                      Per session the end reason and its provenance answer one question together:
                      how much the signed-out time above is worth. `Server` means nothing on the
                      workstation ever recorded an end - the reason is the backend's reading of why,
                      not the agent's report of what happened.
                    */}
                    <Td muted>
                      <span className="inline-flex items-center gap-1.5">
                        {row.endReason ?? "-"}
                        {row.logoutSource === "Server" && <Badge tone="warning">Estimated</Badge>}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {/*
        "showing N" rather than "N entries": only the first page is loaded here, so a total is a
        number this page does not have. The window fetches the rest as it is scrolled.
      */}
      <Card title={`Timeline - showing ${timeline.rows.length}${timeline.hasMore ? "+" : ""}`}>
        <TimelineTable
          initial={timeline}
          employeeId={employee.id}
          startDate={startDate}
          endDate={endDate}
        />
      </Card>

      {/*
        The removable-device trail for this person. Sits after the timeline and before the
        captures: the timeline says what they were doing, this says what could have left the
        machine while they did it.
      */}
      <Card title={`USB devices - showing ${usbEvents.rows.length}${usbEvents.hasMore ? "+" : ""}`}>
        <EmployeeUsbTable
          initial={usbEvents}
          employeeId={employee.id}
          startDate={startDate}
          endDate={endDate}
        />
      </Card>

      {screenshots && (
        <Card
          title={`Screenshots - showing ${screenshots.rows.length}${screenshots.hasMore ? "+" : ""}`}
        >
          <ScreenshotGallery
            initial={screenshots}
            employeeId={employee.id}
            startDate={startDate}
            endDate={endDate}
          />
        </Card>
      )}
    </div>
  );
}
