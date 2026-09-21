// Attendance.tsx (or wherever the tables live)
"use client";

import { TABLE_CLASS, Th, Td, Card, Badge } from "@/components/ui";
import type { AttendanceDay } from "@/types/api";
import { formatDate, formatTime, formatDuration } from "@/lib/format";

interface AttendanceDaysTableProps {
  days: AttendanceDay[];
  height?: string;
}

export function AttendanceDaysTable({ days }: AttendanceDaysTableProps) {
  return (
    <Card title="Attendance">
      {days.length === 0 ? (
        <p className="py-10 text-center text-sm text-text-secondary">
          No sign-in recorded in this period.
        </p>
      ) : (
        <div className="-m-4.5 min-w-0">
          <div className="max-h-108 overflow-x-auto">
            <table className={`${TABLE_CLASS} min-w-180 table-fixed w-full`}>
              <colgroup>
                <col className="w-[18%]" />
                <col className="w-[15%]" />
                <col className="w-[15%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[16%]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-surface">
                <tr>
                  <Th>Date</Th>
                  <Th>First login</Th>
                  <Th>Last logout</Th>
                  <Th>Session</Th>
                  <Th>Active</Th>
                  <Th>Idle</Th>
                  <Th align="right">Status</Th>
                </tr>
              </thead>

              <tbody>
                {days.map((day) => (
                  <tr key={day.workDate}>
                    <Td>{formatDate(day.workDate)}</Td>
                    <Td numeric>{formatTime(day.firstLogin)}</Td>
                    <Td numeric>
                      {day.status === "present" ? (
                        "-"
                      ) : day.lastLogout && day.logoutEstimated ? (
                        <span
                          className="inline-flex items-center gap-1.5"
                          title="Estimated – the workstation stopped reporting without recording a logout"
                        >
                          {formatTime(day.lastLogout)}
                          <Badge tone="warning">Estimated</Badge>
                        </span>
                      ) : (
                        formatTime(day.lastLogout)
                      )}
                    </Td>
                    <Td numeric>{formatDuration(day.sessionSeconds)}</Td>
                    <Td numeric>{formatDuration(day.activeSeconds)}</Td>
                    <Td numeric>{formatDuration(day.idleSeconds)}</Td>
                    <Td align="right">
                      {day.status === "present" ? (
                        <Badge tone="success">Present</Badge>
                      ) : day.status === "unknown" ? (
                        <Badge tone="warning">No logout recorded</Badge>
                      ) : (
                        <Badge>Signed out</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

// Same pattern for AttendanceSessionsTable – remove the format props
export type AttendanceSession = {
  deviceId: string;
  endReason: string | null;
  loginTime: string;
  logoutSource: string | null;
  logoutTime: string | null;
  sessionId: string;
  workDate: string;
};

interface AttendanceSessionsTableProps {
  sessions: AttendanceSession[];
  height?: string;
}

export function AttendanceSessionsTable({ sessions }: AttendanceSessionsTableProps) {
  return (
    <Card title="Attendance sessions">
      {sessions.length === 0 ? (
        <p className="py-10 text-center text-sm text-text-secondary">
          No sign-in recorded in this period.
        </p>
      ) : (
        <div className="-m-4.5 min-w-0">
          <div className={`max-h-108 overflow-x-auto`}>
            <table className={`${TABLE_CLASS} min-w-180 table-fixed w-full`}>
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[24%]" />
                <col className="w-[24%]" />
                <col className="w-[30%]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-surface">
                <tr>
                  <Th>Date</Th>
                  <Th>Signed in</Th>
                  <Th>Signed out</Th>
                  <Th>Ended by</Th>
                </tr>
              </thead>

              <tbody>
                {sessions.map((row) => (
                  <tr key={row.sessionId}>
                    <Td>{formatDate(row.workDate)}</Td>
                    <Td numeric>{formatTime(row.loginTime)}</Td>
                    <Td numeric>
                      {row.logoutTime ? (
                        formatTime(row.logoutTime)
                      ) : (
                        <Badge tone="success">Still signed in</Badge>
                      )}
                    </Td>
                    <Td muted>
                      <span className="inline-flex items-center gap-1.5">
                        {row.endReason ?? "-"}
                        {row.logoutSource === "Server" && <Badge tone="warning">Estimated</Badge>}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
