import Link from 'next/link';
import { apiGet } from '@/lib/api-client';
import { formatDuration, formatPercent, formatRelative } from '@/lib/format';
import { Card, StatTile, ProductivityBar, TableWrap, Th, Td, StatusDot, EmptyState } from '@/components/ui';
import { LiveOnlineTile } from '@/components/LiveOnlineTile';
import { LiveActiveTimeTile } from '@/components/LiveTotals';
import type { Overview, Roster } from '@/types/api';

export const metadata = { title: 'Overview Â· Employee Monitor' };

// Live operational data. Never served from Next's fetch cache, or a manager sees a stale
// "who is online now" â€” see Docs/Frontend/NextJS.md section 3.
export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const [overview, roster] = await Promise.all([
    apiGet<Overview>('/v1/dashboard/reports/overview'),
    apiGet<Roster>('/v1/dashboard/reports/roster'),
  ]);

  const { totals } = overview;

  // Busiest first: on a 30-person team the useful question is who is at the extremes, and the
  // full sortable list is one click away on /employees.
  const topEmployees = [...roster.employees].sort((a, b) => b.activeSeconds - a.activeSeconds).slice(0, 8);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Overview</h1>
        <p className="mt-0.5 text-sm text-text-secondary">
          Last 7 days Â· {overview.employeesTracked} of {overview.headcount} employees reporting
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <LiveOnlineTile fallback={overview.onlineNow} />
        <StatTile
          label="Checked in today"
          value={overview.attendanceToday.checkedIn}
          hint={`${overview.attendanceToday.stillActive} still signed in`}
        />
        <LiveActiveTimeTile baseline={totals.activeSeconds} />
        <StatTile
          label="Open alerts"
          value={overview.openHighSeverityAlerts}
          hint="High and critical, unresolved"
          tone={overview.openHighSeverityAlerts > 0 ? 'danger' : 'default'}
        />
      </div>

      <Card title="Productivity mix">
        <div className="mb-4 flex items-baseline gap-3">
          <span className="tnum text-3xl font-semibold">{formatPercent(totals.productivityPercent)}</span>
          <span className="text-sm text-text-secondary">of active time tagged productive</span>
        </div>

        <ProductivityBar
          productive={totals.productiveSeconds}
          unproductive={totals.unproductiveSeconds}
          neutral={totals.neutralSeconds}
          blacklisted={totals.blacklistedSeconds}
        />

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
          {[
            { label: 'Productive', value: totals.productiveSeconds, dot: 'bg-brand' },
            { label: 'Neutral', value: totals.neutralSeconds, dot: 'bg-text-secondary/40' },
            { label: 'Unproductive', value: totals.unproductiveSeconds, dot: 'bg-warning' },
            { label: 'Blacklisted', value: totals.blacklistedSeconds, dot: 'bg-danger' },
            { label: 'Idle', value: totals.idleSeconds, dot: 'bg-border' },
          ].map((item) => (
            <div key={item.label}>
              <dt className="flex items-center gap-1.5 text-xs text-text-secondary">
                <span className={`inline-block size-2 rounded-full ${item.dot}`} aria-hidden />
                {item.label}
              </dt>
              <dd className="tnum mt-0.5 text-sm font-medium">{formatDuration(item.value)}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card
        title="Most active"
        action={
          <Link href="/employees" className="text-xs text-text-secondary hover:text-text-primary">
            View all â†’
          </Link>
        }
      >
        {topEmployees.length === 0 ? (
          <EmptyState message="No activity recorded yet. Once an agent enrolls and an employee signs in, their time appears here." />
        ) : (
          <TableWrap>
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Department</Th>
                  <Th align="right">Active</Th>
                  <Th align="right">Idle</Th>
                  <Th align="right">Productive</Th>
                  <Th align="right">Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {topEmployees.map((employee) => (
                  <tr key={employee.id} className="group">
                    <Td>
                      <Link
                        href={`/employees/${employee.id}`}
                        className="flex items-center gap-2 font-medium group-hover:text-brand"
                      >
                        <StatusDot online={employee.isOnline} />
                        {employee.name}
                      </Link>
                    </Td>
                    <Td muted>{employee.department ?? 'â€”'}</Td>
                    <Td align="right" numeric>
                      {formatDuration(employee.activeSeconds)}
                    </Td>
                    <Td align="right" numeric muted>
                      {formatDuration(employee.idleSeconds)}
                    </Td>
                    <Td align="right" numeric>
                      {formatPercent(employee.productivityPercent)}
                    </Td>
                    <Td align="right" muted>
                      {formatRelative(employee.lastSeen)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
