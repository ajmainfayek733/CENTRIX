'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { LogScroller, type LogPage } from '@/components/LogScroller';
import { formatDateTime, formatBytes } from '@/lib/format';
import { TableWrap, Th, Td, Badge } from '@/components/ui';
import type { UsbEventRow } from '@/types/api';

/** Removable-device audit trail, paged the same way as the alert feed. */
export function UsbTable({ initial }: { initial: LogPage<UsbEventRow> }) {
  const rowKey = useCallback((event: UsbEventRow) => event.id, []);

  return (
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
      </table>

      <LogScroller
        initial={initial}
        feed="usb"
        rowKey={rowKey}
        emptyMessage="No removable devices connected in this period."
      >
        {(rows) => (
          <table className="w-full min-w-[820px] border-collapse">
            <tbody>
              {rows.map((event) => (
                <tr key={event.id}>
                  <Td muted numeric>
                    {formatDateTime(event.eventTime)}
                  </Td>
                  <Td>
                    <Link
                      href={`/employees/${event.device.employee.id}`}
                      className="font-medium hover:text-brand"
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
                      {event.driveLetter ? ` - ${event.driveLetter}` : ''}
                      {event.volumeLabel ? ` ${event.volumeLabel}` : ''}
                    </span>
                  </Td>
                  <Td muted>
                    <span className="font-mono text-xs">{event.serialNumber ?? '-'}</span>
                  </Td>
                  <Td align="right" numeric muted>
                    {formatBytes(event.capacityBytes)}
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
