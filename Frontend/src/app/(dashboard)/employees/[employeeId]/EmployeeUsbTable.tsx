"use client";

import { useCallback } from "react";
import { LogScroller, type LogPage } from "@/components/LogScroller";
import { formatDateTime, formatBytes } from "@/lib/format";
import { TableWrap, TABLE_CLASS, Th, Td, Badge } from "@/components/ui";
import type { UsbEventRow } from "@/types/api";

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
      <table className={TABLE_CLASS}>
        <colgroup>
          <col className="w-[25%]" />
          <col className="w-[35%]" />
          <col className="w-[25%]" />
          <col className="w-[15%]" />
        </colgroup>

        <thead>
          <tr>
            <Th align="left">When</Th>
            <Th align="left">Device</Th>
            <Th align="left">Serial</Th>
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
          <table className={`${TABLE_CLASS}`}>
            <colgroup>
              <col className="w-[25%]" />
              <col className="w-[35%]" />
              <col className="w-[25%]" />
              <col className="w-[15%]" />
            </colgroup>

            <tbody className="pr-2">
              {rows.map((event) => (
                <tr key={event.id}>
                  <Td align="left" muted numeric>
                    {formatDateTime(event.eventTime)}

                    <span className="mt-2 block text-xs text-text-tertiary">
                      <Badge tone={event.eventType === "Connected" ? "warning" : "neutral"}>
                        {event.eventType}
                      </Badge>
                    </span>
                  </Td>

                  <Td align="left">
                    {event.friendlyName ?? "Unknown device"}

                    <span className="mt-px block text-xs text-text-tertiary">
                      {event.deviceType}
                      {event.driveLetter ? ` - ${event.driveLetter}` : ""}
                      {event.volumeLabel ? ` ${event.volumeLabel}` : ""}
                    </span>
                  </Td>

                  <Td align="left" muted>
                    <span className="font-mono text-xs">{event.serialNumber ?? "-"}</span>
                  </Td>

                  <Td align="right" numeric muted>
                    <span className="pr-4">{formatBytes(event.capacityBytes)}</span>
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
