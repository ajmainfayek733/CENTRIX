'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { LogScroller, type LogPage } from '@/components/LogScroller';
import { formatDateTime, formatDuration } from '@/lib/format';
import { TableWrap, Th, Td, SeverityBadge, Badge } from '@/components/ui';
import type { AlertRow } from '@/types/api';

/** Turns the typed context columns back into one readable line per alert type. */
function describeContext(alert: AlertRow): string {
  if (alert.contextDomain) return alert.contextDomain;
  if (alert.contextAppName) return alert.contextAppName;
  if (alert.contextUsbFriendlyName) return alert.contextUsbFriendlyName;
  if (alert.idleSeconds !== null) return `Idle ${formatDuration(alert.idleSeconds)}`;
  return '-';
}

/**
 * The alert feed as a bounded scroll window.
 *
 * The header is rendered outside the scrolling area so it stays visible while the body scrolls -
 * a log window whose column headings scroll away is unreadable the moment it is used.
 */
export function AlertsTable({ initial }: { initial: LogPage<AlertRow> }) {
  const rowKey = useCallback((alert: AlertRow) => alert.id, []);

  return (
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
      </table>

      <LogScroller
        initial={initial}
        feed="alerts"
        rowKey={rowKey}
        emptyMessage="No open alerts. Idle escalations and blacklist hits appear here as they happen."
      >
        {(rows) => (
          <table className="w-full min-w-[720px] border-collapse">
            <tbody>
              {rows.map((alert) => (
                <tr key={alert.id}>
                  <Td muted numeric>
                    {formatDateTime(alert.triggeredAt)}
                  </Td>
                  <Td>
                    <Link
                      href={`/employees/${alert.device.employee.id}`}
                      className="font-medium hover:text-brand"
                    >
                      {alert.device.employee.name}
                    </Link>
                    <span className="block text-xs text-text-secondary">{alert.device.deviceName}</span>
                  </Td>
                  <Td>
                    {alert.title}
                    {alert.escalationLevel > 1 && (
                      <span className="ml-1.5">
                        <Badge tone="warning">escalated x{alert.escalationLevel}</Badge>
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
        )}
      </LogScroller>
    </TableWrap>
  );
}
