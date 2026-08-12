import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet, ApiError } from '@/lib/api-client';
import { formatDuration, formatPercent, formatTime } from '@/lib/format';
import {
  Card,
  StatTile,
  TableWrap,
  Th,
  Td,
  TagBadge,
  Badge,
  EmptyState,
  ProductivityBar,
} from '@/components/ui';
import type { EmployeeDetail } from '@/types/api';
import { DateRangePicker } from '@/components/DateRangePicker';
import { TimelineTable } from './TimelineTable';

export const dynamic = 'force-dynamic';

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
  if (range.startDate) query.set('startDate', range.startDate);
  if (range.endDate) query.set('endDate', range.endDate);
  const suffix = query.size > 0 ? `?${query}` : '';

  let detail: EmployeeDetail;
  try {
    detail = await apiGet<EmployeeDetail>(`/v1/dashboard/reports/employees/${employeeId}${suffix}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const { employee, totals, timeline, topApps, topDomains, attendance } = detail;
  const { startDate, endDate } = range;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/employees" className="text-xs text-text-secondary hover:text-text-primary">
            ← Employees
          </Link>
          <h1 className="mt-1 text-lg font-semibold">{employee.name}</h1>
          <p className="mt-0.5 text-sm text-text-secondary">
            {employee.email}
            {employee.department ? ` · ${employee.department}` : ''}
          </p>
        </div>
        <DateRangePicker startDate={range.startDate} endDate={range.endDate} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Active" value={formatDuration(totals.activeSeconds)} />
        <StatTile label="Idle" value={formatDuration(totals.idleSeconds)} />
        <StatTile label="Productive" value={formatPercent(totals.productivityPercent)} tone="brand" />
        <StatTile
          label="Blacklisted"
          value={formatDuration(totals.blacklistedSeconds)}
          tone={totals.blacklistedSeconds > 0 ? 'danger' : 'default'}
        />
      </div>

      <Card title="Productivity mix">
        <ProductivityBar
          productive={totals.productiveSeconds}
          unproductive={totals.unproductiveSeconds}
          neutral={totals.neutralSeconds}
          blacklisted={totals.blacklistedSeconds}
        />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Top applications">
          {topApps.length === 0 ? (
            <EmptyState message="No application time recorded in this period." />
          ) : (
            <ul className="space-y-2.5">
              {topApps.map((app) => (
                <li key={`${app.appName}-${app.productivityTag}`} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm">{app.appName ?? 'Unknown'}</span>
                  <TagBadge tag={app.productivityTag} />
                  <span className="tnum w-16 text-right text-sm text-text-secondary">
                    {formatDuration(app.seconds)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Top websites">
          {topDomains.length === 0 ? (
            <EmptyState message="No browsing recorded in this period." />
          ) : (
            <ul className="space-y-2.5">
              {topDomains.map((site) => (
                <li key={`${site.domain}-${site.productivityTag}`} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm">{site.domain}</span>
                  <TagBadge tag={site.productivityTag} />
                  <span className="tnum w-16 text-right text-sm text-text-secondary">
                    {formatDuration(site.seconds)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Attendance">
        {attendance.length === 0 ? (
          <EmptyState message="No sign-in recorded in this period." />
        ) : (
          <TableWrap>
            <table className="w-full min-w-[440px] border-collapse">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>First sign-in</Th>
                  <Th>Last sign-out</Th>
                  <Th>Ended by</Th>
                </tr>
              </thead>
              <tbody>
                {attendance.map((row) => (
                  <tr key={row.sessionId}>
                    <Td>{new Date(row.workDate).toLocaleDateString()}</Td>
                    <Td numeric>{formatTime(row.loginTime)}</Td>
                    <Td numeric>
                      {row.logoutTime ? formatTime(row.logoutTime) : <Badge tone="brand">Still signed in</Badge>}
                    </Td>
                    <Td muted>{row.endReason ?? '—'}</Td>
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
      <Card title={`Timeline · showing ${timeline.rows.length}${timeline.hasMore ? '+' : ''}`}>
        <TimelineTable
          initial={timeline}
          employeeId={employee.id}
          startDate={startDate}
          endDate={endDate}
        />
      </Card>
    </div>
  );
}
