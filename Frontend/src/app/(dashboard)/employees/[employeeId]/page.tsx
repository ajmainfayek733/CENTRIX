import Link from "next/link";
import { notFound } from "next/navigation";
import { apiGet, ApiError } from "@/lib/api-client";
import { formatDuration, formatPercent } from "@/lib/format";
import { ArrowLeft } from "lucide-react";
import {
  Card,
  PageHeader,
  StatTile,
  HeroPercent,
  Legend,
  TagBadge,
  EmptyState,
  ProductivityBar,
} from "@/components/ui";
import type { EmployeeDetail, ScreenshotRow, UsbEventRow } from "@/types/api";
import type { LogPage } from "@/lib/use-log-feed";
import { getSessionUser, canViewScreenshots } from "@/lib/session";
import { DateRangePicker } from "@/components/DateRangePicker";
import { ScreenshotGallery } from "@/components/ScreenshotGallery";
import { ExportPdfButton } from "@/components/ExportPdfButton";
import { TimelineTable } from "./TimelineTable";
import { EmployeeUsbTable } from "./EmployeeUsbTable";
import { WeeklyAttendance } from "./WeeklyAttendance";
import { AttendanceProvider } from "./AttendanceProvider";

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

  const {
    employee,
    period,
    totals,
    timeline,
    topApps,
    topDomains,
    activityMetrics,
    attendance,
    attendanceDays,
    weeklyAttendanceDays,
  } = detail;
  const { startDate, endDate } = range;

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
    <div className="sm:space-y-10 space-y-6">
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
        action={
          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker startDate={range.startDate} endDate={range.endDate} />
            <ExportPdfButton
              employeeId={employee.id}
              employeeName={employee.name}
              startDate={range.startDate}
              endDate={range.endDate}
            />
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile label="Active" value={formatDuration(totals.activeSeconds)} />
        <StatTile label="Idle" value={formatDuration(totals.idleSeconds)} />
        <StatTile
          label="Blacklisted"
          value={formatDuration(totals.blacklistedSeconds)}
          tone={totals.blacklistedSeconds > 0 ? "danger" : "default"}
        />
        {/* Activity Metrics */}
        <div className="overflow-hidden">
          <div className="rounded-lg border border-glass-border bg-surface px-3.5 py-2.5 shadow-glass-sm">
            <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-text-tertiary">
              Activity
            </p>

            <div className="mt-1 flex items-baseline gap-3">
              {/* Total */}
              <div className="flex items-baseline gap-1">
                <span className="tnum text-[20px] font-semibold leading-none tracking-[-0.5px] text-text-primary">
                  {(
                    (activityMetrics?.keyCount ?? 0) + (activityMetrics?.mouseCount ?? 0)
                  ).toLocaleString()}
                </span>
                <span className="text-[10px] text-text-tertiary">Total</span>
              </div>

              {/* Keyboard */}
              <div className="flex items-baseline gap-1">
                <span className="text-[10px] font-medium text-text-tertiary">K</span>
                <span className="tnum text-[12px] font-medium text-text-primary">
                  {(activityMetrics?.keyCount ?? 0).toLocaleString()}
                </span>
              </div>

              {/* Mouse */}
              <div className="flex items-baseline gap-1">
                <span className="text-[10px] font-medium text-text-tertiary">M</span>
                <span className="tnum text-[12px] font-medium text-text-primary">
                  {(activityMetrics?.mouseCount ?? 0).toLocaleString()}
                </span>
              </div>
            </div>

            {/* Mouse breakdown */}
            <div className="mt-1 flex items-center gap-2 text-[9px] text-text-secondary">
              <span>
                ML&nbsp;
                <span className="tnum text-text-primary">
                  {(activityMetrics?.mouseLeftKeyCount ?? 0).toLocaleString()}
                </span>
              </span>

              <span>
                MR&nbsp;
                <span className="tnum text-text-primary">
                  {(activityMetrics?.mouseRightKeyCount ?? 0).toLocaleString()}
                </span>
              </span>

              <span>
                MM&nbsp;
                <span className="tnum text-text-primary">
                  {(activityMetrics?.mouseMiddleKeyCount ?? 0).toLocaleString()}
                </span>
              </span>

              <span>
                MO&nbsp;
                <span className="tnum text-text-primary">
                  {(activityMetrics?.mouseOtherKeyCount ?? 0).toLocaleString()}
                </span>
              </span>
            </div>
          </div>
        </div>
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
          attendanceDays={weeklyAttendanceDays ?? attendanceDays}
          periodStart={period.start}
          periodEnd={period.end}
        />
      </Card>

      <div className="grid gap-3.5 lg:grid-cols-3">
        <Card title="Top applications">
          <div className="h-125 -m-4.5 overflow-x-auto">
            <div className="min-w-xs p-4">
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
                              <span
                                className="h-2 w-2 shrink-0 rounded-full bg-success-vivid"
                                aria-hidden
                              />
                              <span className="tnum font-medium text-text-primary">
                                {formatDuration(app.productiveSeconds)}
                              </span>
                            </span>
                          )}
                          {app.neutralSeconds > 0 && (
                            <span className="inline-flex items-center gap-1.5" title="Neutral">
                              <span
                                className="h-2 w-2 shrink-0 rounded-full bg-neutral-dot"
                                aria-hidden
                              />
                              <span className="tnum font-medium text-text-primary">
                                {formatDuration(app.neutralSeconds)}
                              </span>
                            </span>
                          )}
                          {app.unproductiveSeconds > 0 && (
                            <span className="inline-flex items-center gap-1.5" title="Unproductive">
                              <span
                                className="h-2 w-2 shrink-0 rounded-full bg-warning"
                                aria-hidden
                              />
                              <span className="tnum font-medium text-text-primary">
                                {formatDuration(app.unproductiveSeconds)}
                              </span>
                            </span>
                          )}
                          {app.blacklistedSeconds > 0 && (
                            <span className="inline-flex items-center gap-1.5" title="Blacklisted">
                              <span
                                className="h-2 w-2 shrink-0 rounded-full bg-danger"
                                aria-hidden
                              />
                              <span className="tnum font-medium text-danger">
                                {formatDuration(app.blacklistedSeconds)}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <span className="tnum block text-[13.5px] font-semibold text-text-primary">
                          {formatDuration(app.seconds)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>

        <Card title="Top websites">
          <div className="h-125 -m-4.5 overflow-x-auto">
            <div className="min-w-xs p-4">
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
                          <span
                            className="truncate font-medium text-text-primary"
                            title={site.domain}
                          >
                            {site.domain}
                          </span>
                          <TagBadge tag={site.productivityTag} />
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-text-secondary">
                          {site.productiveSeconds > 0 && (
                            <span className="inline-flex items-center gap-1.5" title="Productive">
                              <span
                                className="h-2 w-2 shrink-0 rounded-full bg-success-vivid"
                                aria-hidden
                              />
                              <span className="tnum font-medium text-text-primary">
                                {formatDuration(site.productiveSeconds)}
                              </span>
                            </span>
                          )}
                          {site.neutralSeconds > 0 && (
                            <span className="inline-flex items-center gap-1.5" title="Neutral">
                              <span
                                className="h-2 w-2 shrink-0 rounded-full bg-neutral-dot"
                                aria-hidden
                              />
                              <span className="tnum font-medium text-text-primary">
                                {formatDuration(site.neutralSeconds)}
                              </span>
                            </span>
                          )}
                          {site.unproductiveSeconds > 0 && (
                            <span className="inline-flex items-center gap-1.5" title="Unproductive">
                              <span
                                className="h-2 w-2 shrink-0 rounded-full bg-warning"
                                aria-hidden
                              />
                              <span className="tnum font-medium text-text-primary">
                                {formatDuration(site.unproductiveSeconds)}
                              </span>
                            </span>
                          )}
                          {site.blacklistedSeconds > 0 && (
                            <span className="inline-flex items-center gap-1.5" title="Blacklisted">
                              <span
                                className="h-2 w-2 shrink-0 rounded-full bg-danger"
                                aria-hidden
                              />
                              <span className="tnum font-medium text-danger">
                                {formatDuration(site.blacklistedSeconds)}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <span className="tnum block text-[13.5px] font-semibold text-text-primary">
                          {formatDuration(site.seconds)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>

        {/*
        The removable-device trail for this person. Sits after the timeline and before the
        captures: the timeline says what they were doing, this says what could have left the
        machine while they did it.
      */}
        <Card
          title={`USB devices - showing ${usbEvents.rows.length}${usbEvents.hasMore ? "+" : ""}`}
        >
          <EmployeeUsbTable
            initial={usbEvents}
            employeeId={employee.id}
            startDate={startDate}
            endDate={endDate}
          />
        </Card>
      </div>

      <AttendanceProvider
        attendanceInitial={attendanceDays}
        attendanceSessionsInitial={attendance}
      ></AttendanceProvider>

      <Card title={`Timeline - showing ${timeline.rows.length}${timeline.hasMore ? "+" : ""}`}>
        <TimelineTable
          initial={timeline}
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
