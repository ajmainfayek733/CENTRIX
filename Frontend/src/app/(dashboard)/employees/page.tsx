import Link from 'next/link';
import { apiGet } from '@/lib/api-client';
import { formatDuration, formatPercent, formatRelative } from '@/lib/format';
import { Card, TableWrap, Th, Td, StatusDot, EmptyState, ProductivityBar } from '@/components/ui';
import type { Roster } from '@/types/api';

export const metadata = { title: 'Employees · Employee Monitor' };
export const dynamic = 'force-dynamic';

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ startDate?: string; endDate?: string }>;
}) {
  const params = await searchParams;

  const query = new URLSearchParams();
  if (params.startDate) query.set('startDate', params.startDate);
  if (params.endDate) query.set('endDate', params.endDate);
  const suffix = query.size > 0 ? `?${query}` : '';

  const roster = await apiGet<Roster>(`/v1/dashboard/reports/roster${suffix}`);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Employees</h1>
        <p className="mt-0.5 text-sm text-text-secondary">
          {roster.employees.length} tracked · {new Date(roster.period.start).toLocaleDateString()} to{' '}
          {new Date(roster.period.end).toLocaleDateString()}
        </p>
      </div>

      <Card>
        {roster.employees.length === 0 ? (
          <EmptyState message="No employees yet. Create them from the API or assign a self-enrolled device on the Devices screen." />
        ) : (
          <TableWrap>
            <table className="w-full min-w-[760px] border-collapse">
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Department</Th>
                  <Th align="right">Devices</Th>
                  <Th align="right">Active</Th>
                  <Th align="right">Idle</Th>
                  <Th align="right">Productive</Th>
                  <Th>Mix</Th>
                  <Th align="right">Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {roster.employees.map((employee) => (
                  <tr key={employee.id} className="group">
                    <Td>
                      <Link
                        href={`/employees/${employee.id}`}
                        className="flex items-center gap-2 font-medium group-hover:text-accent"
                      >
                        <StatusDot online={employee.isOnline} />
                        <span>
                          {employee.name}
                          <span className="block text-xs font-normal text-text-secondary">{employee.email}</span>
                        </span>
                      </Link>
                    </Td>
                    <Td muted>{employee.department ?? '—'}</Td>
                    <Td align="right" numeric muted>
                      {employee.deviceCount}
                    </Td>
                    <Td align="right" numeric>
                      {formatDuration(employee.activeSeconds)}
                    </Td>
                    <Td align="right" numeric muted>
                      {formatDuration(employee.idleSeconds)}
                    </Td>
                    <Td align="right" numeric>
                      {formatPercent(employee.productivityPercent)}
                    </Td>
                    <Td>
                      <div className="w-24">
                        <ProductivityBar
                          productive={employee.productiveSeconds}
                          unproductive={employee.unproductiveSeconds}
                          neutral={employee.neutralSeconds}
                          blacklisted={employee.blacklistedSeconds}
                        />
                      </div>
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
