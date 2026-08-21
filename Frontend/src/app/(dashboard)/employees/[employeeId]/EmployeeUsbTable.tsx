'use client';

import { useCallback } from 'react';
import { LogScroller, type LogPage } from '@/components/LogScroller';
import { formatDateTime, formatBytes } from '@/lib/format';
import { TableWrap, TABLE_CLASS, Th, Td, Badge } from '@/components/ui';
import type { UsbEventRow } from '@/types/api';

/**
 * One employee's removable-device trail, paged the same way as the timeline above it.
 *
 * The org-wide version of this table lives on the alerts screen. This one drops the Employee
 * column - every row belongs to the person whose page this is, so repeating the name down the
 * column says nothing - and shows the device instead, which is the question that does arise
 * when someone has two machines.
 *
 * Rows are not filtered here. The feed resolves to a per-employee endpoint that filters in the
 * query, because keyset paging over a client-side filter would hand back pages that look empty
 * without being the end of the trail.
 */
export function EmployeeUsbTable({
  initial,
  employeeId,
  startDate,
  endDate,
}: {
  initial: LogPage<UsbEventRow>;
  employeeId: string;
  startDate?: string;
  endDate?: string;
}) {
  const rowKey = useCallback((event: UsbEventRow) => event.id, []);

  return (
    <TableWrap>
      <table className={`${TABLE_CLASS} min-w-[720px]`}>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Event</Th>
            <Th>Device</Th>
            <Th>Workstation</Th>
            <Th>Serial</Th>
            <Th align="right">Capacity</Th>
          </tr>
        </thead>
      </table>

      <LogScroller
        initial={initial}
        feed="employee-usb"
        params={{ employeeId, startDate, endDate }}
        rowKey={rowKey}
        emptyMessage="No removable devices connected in this period."
      >
        {(rows) => (
          <table className={`${TABLE_CLASS} min-w-[720px]`}>
            <tbody>
              {rows.map((event) => (
                <tr key={event.id}>
                  <Td muted numeric>
                    {formatDateTime(event.eventTime)}
                  </Td>
                  <Td>
                    {/*
                      A connect is the event worth noticing - it is the moment data could leave -
                      so it carries the warning tone and a disconnect stays neutral.
                    */}
                    <Badge tone={event.eventType === 'Connected' ? 'warning' : 'neutral'}>
                      {event.eventType}
                    </Badge>
                  </Td>
                  <Td>
                    {event.friendlyName ?? 'Unknown device'}
                    <span className="mt-px block text-xs text-text-tertiary">
                      {event.deviceType}
                      {event.driveLetter ? ` - ${event.driveLetter}` : ''}
                      {event.volumeLabel ? ` ${event.volumeLabel}` : ''}
                    </span>
                  </Td>
                  <Td muted>{event.device.deviceName}</Td>
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
