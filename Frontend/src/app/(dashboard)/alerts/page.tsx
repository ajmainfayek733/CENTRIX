import Link from 'next/link';
import { apiGet } from '@/lib/api-client';
import { formatDateTime, formatDuration, formatBytes } from '@/lib/format';
import { Card, TableWrap, Th, Td, SeverityBadge, Badge, EmptyState } from '@/components/ui';
import type { AlertRow, UsbEventRow } from '@/types/api';

export const metadata = { title: 'Alerts · Employee Monitor' };
export const dynamic = 'force-dynamic';

/** Turns the typed context columns back into one readable line per alert type. */
function describeContext(alert: AlertRow): string {
  if (alert.contextDomain) return alert.contextDomain;
  if (alert.contextAppName) return alert.contextAppName;
  if (alert.contextUsbFriendlyName) return alert.contextUsbFriendlyName;
  if (alert.idleSeconds !== null) return `Idle ${formatDuration(alert.idleSeconds)}`;
  return '—';
}

export default async function AlertsPage() {
  const [alerts, usb] = await Promise.all([
    apiGet<{ alerts: AlertRow[] }>('/v1/dashboard/reports/alerts'),
    apiGet<{ events: UsbEventRow[] }>('/v1/dashboard/reports/usb-events'),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Alerts &amp; device activity</h1>
        <p className="mt-0.5 text-sm text-text-secondary">
          Unresolved alerts and the removable-device audit trail.
        </p>
      </div>

      <Card title={`Open alerts · ${alerts.alerts.length}`}>
        {alerts.alerts.length === 0 ? (
          <EmptyState message="No open alerts. Idle escalations and blacklist hits appear here as they happen." />
        ) : (
          <TableWrap>
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr>
                  <Th>Triggered</Th>
                  <Th>Employee</Th>
                  <Th>Alert</Th>
                  <Th>Context</Th>
                  <Th align="right">Severity</Th>
                </tr>
              </thead>
              <tbody>
                {alerts.alerts.map((alert) => (
                  <tr key={alert.id}>
                    <Td muted numeric>
                      {formatDateTime(alert.triggeredAt)}
                    </Td>
                    <Td>
                      <Link
                        href={`/employees/${alert.device.employee.id}`}
                        className="font-medium hover:text-accent"
                      >
                        {alert.device.employee.name}
                      </Link>
                      <span className="block text-xs text-text-secondary">{alert.device.deviceName}</span>
                    </Td>
                    <Td>
                      {alert.title}
                      {alert.escalationLevel > 1 && (
                        <span className="ml-1.5">
                          <Badge tone="warning">escalated ×{alert.escalationLevel}</Badge>
                        </span>
                      )}
                    </Td>
                    <Td muted>
                      <span className="block max-w-[18rem] truncate">{describeContext(alert)}</span>
                    </Td>
                    <Td align="right">
                      <SeverityBadge severity={alert.severity} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title={`USB devices · last 7 days`}>
        {usb.events.length === 0 ? (
          <EmptyState message="No removable devices connected in this period." />
        ) : (
          <TableWrap>
            <table className="w-full min-w-[820px] border-collapse">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Employee</Th>
                  <Th>Event</Th>
                  <Th>Device</Th>
                  <Th>Serial</Th>
                  <Th align="right">Capacity</Th>
                </tr>
              </thead>
              <tbody>
                {usb.events.map((event) => (
                  <tr key={event.id}>
                    <Td muted numeric>
                      {formatDateTime(event.eventTime)}
                    </Td>
                    <Td>
                      <Link
                        href={`/employees/${event.device.employee.id}`}
                        className="font-medium hover:text-accent"
                      >
                        {event.device.employee.name}
                      </Link>
                    </Td>
                    <Td>
                      <Badge tone={event.eventType === 'Connected' ? 'warning' : 'neutral'}>
                        {event.eventType}
                      </Badge>
                    </Td>
                    <Td>
                      {event.friendlyName ?? 'Unknown device'}
                      <span className="block text-xs text-text-secondary">
                        {event.deviceType}
                        {event.driveLetter ? ` · ${event.driveLetter}` : ''}
                        {event.volumeLabel ? ` ${event.volumeLabel}` : ''}
                      </span>
                    </Td>
                    <Td muted>
                      <span className="font-mono text-xs">{event.serialNumber ?? '—'}</span>
                    </Td>
                    <Td align="right" numeric muted>
                      {formatBytes(event.capacityBytes)}
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
