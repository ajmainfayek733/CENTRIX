import {
  Card,
  PageHeader,
  StatTile,
  Badge,
  StatusDot,
  TableWrap,
  TABLE_CLASS,
  Th,
  Td,
} from '@/components/ui';
import { BarChart } from '@/components/charts';
import { TemplateNotice } from '@/components/TemplateNotice';

export const metadata = { title: 'Attendance - Employee Monitor' };

/**
 * Team-wide daily attendance, laid out from the blueprint.
 *
 * Per-employee attendance already exists and is real - it is the two tables on the employee
 * detail screen, built from `/v1/dashboard/reports/employees/:id`. What is missing is the
 * team-wide roll-up this screen wants, which no endpoint returns.
 */

/** Invented. Generic names on purpose - see the note in TemplateNotice. */
const PLACEHOLDER_LOG = [
  { name: 'Employee A', checkIn: '-', status: 'unknown' as const },
  { name: 'Employee B', checkIn: '-', status: 'unknown' as const },
  { name: 'Employee C', checkIn: '-', status: 'unknown' as const },
  { name: 'Employee D', checkIn: '-', status: 'unknown' as const },
];

const PLACEHOLDER_WEEK = [
  { label: 'Mon', value: 0 },
  { label: 'Tue', value: 0 },
  { label: 'Wed', value: 0 },
  { label: 'Thu', value: 0 },
  { label: 'Fri', value: 0 },
  { label: 'Sat', value: 0 },
  { label: 'Sun', value: 0 },
];

export default function AttendancePage() {
  return (
    <div className="space-y-3.5">
      <PageHeader title="Attendance" subtitle="Daily check-in and activity summary" />

      <TemplateNotice endpoint="a team-wide attendance endpoint" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Present today" value="-" hint="Still signed in" />
        <StatTile label="Absent" value="-" hint="No activity recorded" />
        <StatTile label="Team active time" value="-" hint="Today" />
        <StatTile label="Avg. idle" value="-" hint="Per active employee" />
      </div>

      <div className="grid gap-3.5 xl:grid-cols-[1.5fr_1fr]">
        <Card title="Weekly active time">
          <BarChart
            bars={PLACEHOLDER_WEEK}
            unit="h"
            caption="Placeholder weekly active hours; no data is connected yet"
          />
        </Card>

        <Card title="Today's log">
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
                {PLACEHOLDER_LOG.map((entry) => (
                  <tr key={entry.name}>
                    <Td>
                      <span className="flex items-center gap-2.5 font-medium">
                        <StatusDot online={false} />
                        {entry.name}
                      </span>
                    </Td>
                    <Td muted>{entry.checkIn}</Td>
                    <Td>
                      {/* Neither "Present" nor "Absent": with no data behind it, asserting
                          either about anyone would be inventing an attendance record. */}
                      <Badge>No data</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      </div>
    </div>
  );
}
