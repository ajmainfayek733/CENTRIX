import { apiGet } from '@/lib/api-client';
import { getSessionUser } from '@/lib/session';
import { Card, TableWrap, Th, Td, Badge, EmptyState } from '@/components/ui';
import { LiveDeviceStatus, LiveStatusDot } from '@/components/LiveDeviceStatus';
import type { DeviceRow, EmployeeSummary } from '@/types/api';
import { DeviceActions } from './DeviceActions';
import { DeviceAssignment } from './DeviceAssignment';

export const metadata = { title: 'Devices - Employee Monitor' };
export const dynamic = 'force-dynamic';

export default async function DevicesPage() {
  const [devices, employees, user] = await Promise.all([
    apiGet<DeviceRow[]>('/v1/dashboard/employees/devices'),
    apiGet<EmployeeSummary[]>('/v1/dashboard/employees'),
    getSessionUser(),
  ]);

  const assignable = employees.map((employee) => ({
    id: employee.id,
    name: employee.name,
    department: employee.department,
  }));

  // Devices enroll themselves and park on a placeholder employee until an admin assigns them,
  // so unassigned ones are surfaced first - they are the actionable set.
  const unassigned = devices.filter((device) => device.employee.status === 'placeholder');
  const assigned = devices.filter((device) => device.employee.status !== 'placeholder');

  const isAdmin = user?.role === 'super_admin';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Devices</h1>
        <p className="mt-0.5 text-sm text-text-secondary">
          {devices.length} enrolled - {unassigned.length} awaiting assignment
        </p>
      </div>

      {unassigned.length > 0 && (
        <Card title="Awaiting assignment">
          <p className="mb-4 text-sm text-text-secondary">
            These workstations enrolled with the org token but are not attached to an employee yet.
            Their telemetry is being stored, but it will not appear in reports until assigned.
            {employees.length === 0 && ' Create employees first - import a roster from the Employees screen.'}
          </p>
          <DeviceTable devices={unassigned} employees={assignable} isAdmin={isAdmin} />
        </Card>
      )}

      <Card title="Enrolled devices">
        {assigned.length === 0 ? (
          <EmptyState message="No devices assigned yet. Run Deploy-Agent.ps1 on a workstation to enroll it." />
        ) : (
          <DeviceTable devices={assigned} employees={assignable} isAdmin={isAdmin} />
        )}
      </Card>
    </div>
  );
}

function DeviceTable({
  devices,
  employees,
  isAdmin,
}: {
  devices: DeviceRow[];
  employees: Array<{ id: string; name: string; department: string | null }>;
  isAdmin: boolean;
}) {
  return (
    <TableWrap>
      <table className="w-full min-w-[860px] border-collapse">
        <thead>
          <tr>
            <Th>Device</Th>
            <Th>Assigned to</Th>
            <Th>Operating system</Th>
            <Th>MAC</Th>
            <Th align="right">Agent</Th>
            <Th align="right">Last seen</Th>
            {isAdmin && <Th align="right">Actions</Th>}
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => {
            return (
              <tr key={device.id}>
                <Td>
                  <span className="flex items-center gap-2 font-medium">
                    <LiveStatusDot
                      deviceId={device.id}
                      lastSeen={device.lastSeen}
                      isActive={device.isActive}
                    />
                    {device.deviceName}
                  </span>
                  <span className="block pl-4 font-mono text-[11px] text-text-secondary">
                    {device.deviceId}
                  </span>
                </Td>
                <Td muted>
                  {isAdmin ? (
                    <DeviceAssignment
                      deviceId={device.id}
                      employees={employees}
                      currentEmployeeId={device.employee.id}
                      isUnassigned={device.employee.status === 'placeholder'}
                    />
                  ) : device.employee.status === 'placeholder' ? (
                    <Badge tone="warning">Unassigned</Badge>
                  ) : (
                    device.employee.name
                  )}
                </Td>
                <Td muted>
                  {device.edition ?? '-'}
                  <span className="block text-xs">{device.version ?? ''}</span>
                </Td>
                <Td muted>
                  <span className="font-mono text-xs">{device.macAddress ?? '-'}</span>
                </Td>
                <Td align="right" muted numeric>
                  {device.agentVersion ?? '-'}
                </Td>
                <Td align="right" muted>
                  <LiveDeviceStatus
                    deviceId={device.id}
                    lastSeen={device.lastSeen}
                    isActive={device.isActive}
                  />
                </Td>
                {isAdmin && (
                  <Td align="right">
                    <DeviceActions deviceId={device.id} isActive={device.isActive} />
                  </Td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}
