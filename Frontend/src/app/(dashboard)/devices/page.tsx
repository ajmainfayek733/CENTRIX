import { apiGet } from '@/lib/api-client';
import { formatRelative } from '@/lib/format';
import { getSessionUser } from '@/lib/session';
import { Card, TableWrap, Th, Td, StatusDot, Badge, EmptyState } from '@/components/ui';
import type { DeviceRow } from '@/types/api';
import { DeviceActions } from './DeviceActions';

export const metadata = { title: 'Devices · Employee Monitor' };
export const dynamic = 'force-dynamic';

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export default async function DevicesPage() {
  const [devices, user] = await Promise.all([
    apiGet<DeviceRow[]>('/v1/dashboard/employees/devices'),
    getSessionUser(),
  ]);

  // Devices enroll themselves and park on a placeholder employee until an admin assigns them,
  // so unassigned ones are surfaced first — they are the actionable set.
  const unassigned = devices.filter((device) => device.employee.status === 'placeholder');
  const assigned = devices.filter((device) => device.employee.status !== 'placeholder');

  const isAdmin = user?.role === 'super_admin';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Devices</h1>
        <p className="mt-0.5 text-sm text-text-secondary">
          {devices.length} enrolled · {unassigned.length} awaiting assignment
        </p>
      </div>

      {unassigned.length > 0 && (
        <Card title="Awaiting assignment">
          <p className="mb-4 text-sm text-text-secondary">
            These workstations enrolled with the org token but are not attached to an employee yet.
            Their telemetry is being stored, but it will not appear in reports until assigned.
          </p>
          <DeviceTable devices={unassigned} isAdmin={isAdmin} />
        </Card>
      )}

      <Card title="Enrolled devices">
        {assigned.length === 0 ? (
          <EmptyState message="No devices assigned yet. Run Deploy-Agent.ps1 on a workstation to enroll it." />
        ) : (
          <DeviceTable devices={assigned} isAdmin={isAdmin} />
        )}
      </Card>
    </div>
  );
}

function DeviceTable({ devices, isAdmin }: { devices: DeviceRow[]; isAdmin: boolean }) {
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
            const isOnline =
              device.isActive &&
              !!device.lastSeen &&
              Date.now() - new Date(device.lastSeen).getTime() < ONLINE_WINDOW_MS;

            return (
              <tr key={device.id}>
                <Td>
                  <span className="flex items-center gap-2 font-medium">
                    <StatusDot online={isOnline} />
                    {device.deviceName}
                  </span>
                  <span className="block pl-4 font-mono text-[11px] text-text-secondary">
                    {device.deviceId}
                  </span>
                </Td>
                <Td muted>
                  {device.employee.status === 'placeholder' ? (
                    <Badge tone="warning">Unassigned</Badge>
                  ) : (
                    device.employee.name
                  )}
                </Td>
                <Td muted>
                  {device.edition ?? '—'}
                  <span className="block text-xs">{device.version ?? ''}</span>
                </Td>
                <Td muted>
                  <span className="font-mono text-xs">{device.macAddress ?? '—'}</span>
                </Td>
                <Td align="right" muted numeric>
                  {device.agentVersion ?? '—'}
                </Td>
                <Td align="right" muted>
                  {device.isActive ? formatRelative(device.lastSeen) : <Badge tone="danger">Deactivated</Badge>}
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
