'use client';

import { useCallback } from 'react';
import { LogScroller, type LogPage } from '@/components/LogScroller';
import { formatDuration, formatTime } from '@/lib/format';
import { TableWrap, Th, Td, TagBadge } from '@/components/ui';
import type { ActivityType, TimelineRow } from '@/types/api';

/** Types that are not foreground work; rendered dimmed and without a productivity tag. */
const NON_WORKING: ActivityType[] = ['Idle', 'Locked', 'Sleeping', 'Disconnected'];

/**
 * The activity timeline as a fixed-height scroll window.
 *
 * Newest first, one page at a time. The previous version rendered up to 2,000 rows in one go -
 * an unbounded query on the server and thousands of DOM nodes for entries nobody scrolled to.
 */
export function TimelineTable({
  initial,
  employeeId,
  startDate,
  endDate,
}: {
  initial: LogPage<TimelineRow>;
  employeeId: string;
  startDate?: string;
  endDate?: string;
}) {
  const rowKey = useCallback((row: TimelineRow) => row.id, []);

  return (
    <TableWrap>
      <table className="w-full min-w-[720px] border-collapse">
        <thead>
          <tr>
            <Th>Time</Th>
            <Th>Application</Th>
            <Th>Window</Th>
            <Th align="right">Duration</Th>
            <Th align="right">Tag</Th>
          </tr>
        </thead>
      </table>

      <LogScroller
        initial={initial}
        feed="activity"
        params={{ employeeId, startDate, endDate }}
        rowKey={rowKey}
        emptyMessage="No activity recorded in this period."
      >
        {(rows) => (
          <table className="w-full min-w-[720px] border-collapse">
            <tbody>
              {rows.map((row) => {
                const isIdle = NON_WORKING.includes(row.type);

                return [
                  <tr key={row.id} className={isIdle ? 'opacity-60' : undefined}>
                    <Td numeric muted>
                      {formatTime(row.startTime)}
                    </Td>
                    <Td>{isIdle ? row.type : (row.appName ?? row.processName ?? 'Unknown')}</Td>
                    <Td muted>
                      <span className="block max-w-[26rem] truncate">{row.windowTitle ?? '-'}</span>
                    </Td>
                    <Td align="right" numeric>
                      {formatDuration(row.durationSeconds)}
                    </Td>
                    <Td align="right">{!isIdle && <TagBadge tag={row.productivityTag} />}</Td>
                  </tr>,

                  // Browser visits nest under the app session that contained them, so a
                  // "Chrome - 2h" row can be read as the sites that made it up.
                  ...row.visits.map((visit) => (
                    <tr key={visit.id} className="text-xs">
                      <Td />
                      <Td muted>
                        <span className="pl-4 text-text-secondary">{'->'} {visit.domain}</span>
                      </Td>
                      <Td muted>
                        <span className="block max-w-[26rem] truncate">
                          {visit.pageTitle ?? visit.rawUrl}
                        </span>
                      </Td>
                      <Td align="right" numeric muted>
                        {formatDuration(visit.durationSeconds)}
                      </Td>
                      <Td align="right">
                        <TagBadge tag={visit.productivityTag} />
                      </Td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        )}
      </LogScroller>
    </TableWrap>
  );
}
