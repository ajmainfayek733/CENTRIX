import { apiGet } from "@/lib/api-client";
import { formatDate, formatDuration, formatTime } from "@/lib/format";
import {
  Card,
  PageHeader,
  StatTile,
  Badge,
  TableWrap,
  TABLE_CLASS,
  Th,
  Td,
  EntityCell,
  EmptyState,
} from "@/components/ui";
import { BarChart } from "@/components/charts";
import type { TeamAttendance, TeamAttendanceLogRow } from "@/types/api";

export const metadata = { title: "Attendance - C E N T R I X" };
export const dynamic = "force-dynamic";

const SECONDS_PER_HOUR = 3600;

function hoursFromSeconds(seconds: number): number {
  return Math.round((seconds / SECONDS_PER_HOUR) * 10) / 10;
}

function statusBadge(row: TeamAttendanceLogRow) {
  if (row.status === "present") return <Badge tone="success">Present</Badge>;
  if (row.status === "unknown") return <Badge tone="warning">No logout recorded</Badge>;
  if (row.status === "absent") return <Badge>Absent</Badge>;
  return <Badge>Signed out</Badge>;
}

export default async function AttendancePage() {
  const attendance = await apiGet<TeamAttendance>("/v1/dashboard/reports/attendance");
  const weekBars = attendance.weeklyActive.map((day) => ({
    label: day.label,
    value: hoursFromSeconds(day.activeSeconds),
  }));

  return (
    <div className="space-y-3.5">
      <PageHeader
        title="Attendance"
        subtitle={`Daily check-in for ${formatDate(attendance.workDate)} - ${attendance.checkedIn} of ${attendance.headcount} signed in`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Present today"
          value={attendance.present}
          hint={`${attendance.checkedIn} checked in`}
        />
        <StatTile
          label="Absent"
          value={attendance.absent}
          hint="No activity recorded"
        />
        <StatTile
          label="Team active time"
          value={formatDuration(attendance.teamActiveSeconds)}
          hint="Today"
        />
        <StatTile
          label="Avg. idle"
          value={formatDuration(attendance.avgIdleSeconds)}
          hint="Per active employee"
        />
      </div>

      <div className="grid gap-3.5 xl:grid-cols-[1.5fr_1fr]">
        <Card title="Weekly active time">
          <BarChart
            bars={weekBars}
            unit="h"
            caption="Team active hours for the last seven days"
          />
        </Card>

        <Card title="Today's log">
          {attendance.log.length === 0 ? (
            <EmptyState message="No employees yet. Import a roster and assign devices before attendance can appear here." />
          ) : (
            <TableWrap>
              <table className={`${TABLE_CLASS} min-w-[320px]`}>
                <thead>
                  <tr>
                    <Th>Employee</Th>
                    <Th>Check-in</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {attendance.log.map((entry) => (
                    <tr key={entry.employeeId}>
                      <Td>
                        <EntityCell
                          online={entry.isOnline}
                          name={entry.name}
                          href={`/employees/${entry.employeeId}`}
                        />
                      </Td>
                      <Td muted>
                        {entry.status === "absent" ? "-" : formatTime(entry.firstLogin)}
                      </Td>
                      <Td>{statusBadge(entry)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>
    </div>
  );
}
