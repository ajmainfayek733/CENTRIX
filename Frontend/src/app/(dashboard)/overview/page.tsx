import Link from "next/link";
import { apiGet } from "@/lib/api-client";
import { formatDuration, formatPercent, formatRelative } from "@/lib/format";
import {
  Card,
  PageHeader,
  StatTile,
  HeroPercent,
  ProductivityBar,
  Legend,
  TableWrap,
  TABLE_CLASS,
  Th,
  Td,
  EntityCell,
  EmptyState,
} from "@/components/ui";
import { LiveOnlineTile } from "@/components/LiveOnlineTile";
import { LiveActiveTimeTile } from "@/components/LiveTotals";
import type { Overview, Roster } from "@/types/api";

export const metadata = { title: "Overview - C E N T R I X" };

// Live operational data. Never served from Next's fetch cache, or a manager sees a stale
// "who is online now" - see Docs/frontend/session-and-auth.md.
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [overview, roster] = await Promise.all([
    apiGet<Overview>("/v1/dashboard/reports/overview"),
    apiGet<Roster>("/v1/dashboard/reports/roster"),
  ]);

  const { totals } = overview;

  // Busiest first: on a 30-person team the useful question is who is at the extremes, and the
  // full sortable list is one click away on /employees.
  const topEmployees = [...roster.employees]
    .sort((a, b) => b.activeSeconds - a.activeSeconds)
    .slice(0, 8);

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle={`Last 7 days - ${overview.employeesTracked} of ${overview.headcount} employees reporting`}
      />

      <div className="mb-3.5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <LiveOnlineTile fallback={overview.onlineNow} />
        <StatTile
          label="Checked in today"
          value={overview.attendanceToday.checkedIn}
          hint={`${overview.attendanceToday.stillActive} still signed in`}
        />
        <LiveActiveTimeTile baseline={totals.activeSeconds} />
        <StatTile
          label="Open alerts"
          value={overview.openHighSeverityAlerts}
          hint="High and critical, unresolved"
          tone={overview.openHighSeverityAlerts > 0 ? "danger" : "default"}
        />
      </div>

      <Card title="Productivity mix" className="mb-3.5">
        <HeroPercent
          value={formatPercent(totals.productivityPercent)}
          caption="of active time tagged productive"
        />

        <div className="my-3.5">
          <ProductivityBar
            productive={totals.productiveSeconds}
            unproductive={totals.unproductiveSeconds}
            neutral={totals.neutralSeconds}
            blacklisted={totals.blacklistedSeconds}
          />
        </div>

        <Legend
          items={[
            {
              key: "productive",
              label: "Productive",
              value: formatDuration(totals.productiveSeconds),
            },
            { key: "neutral", label: "Neutral", value: formatDuration(totals.neutralSeconds) },
            {
              key: "unproductive",
              label: "Unproductive",
              value: formatDuration(totals.unproductiveSeconds),
            },
            {
              key: "blacklisted",
              label: "Blacklisted",
              value: formatDuration(totals.blacklistedSeconds),
            },
            { key: "idle", label: "Idle", value: formatDuration(totals.idleSeconds) },
          ]}
        />
      </Card>

      <Card
        title="Most active"
        action={
          <Link href="/employees" className="text-[13px] font-medium text-brand hover:underline">
            View all {"->"}
          </Link>
        }
      >
        {topEmployees.length === 0 ? (
          <EmptyState message="No activity recorded yet. Once an agent enrolls and an employee signs in, their time appears here." />
        ) : (
          <TableWrap>
            <table className={`${TABLE_CLASS} min-w-[620px]`}>
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Department</Th>
                  <Th align="right">Active</Th>
                  <Th align="right">Idle</Th>
                  <Th align="right">Productive</Th>
                  <Th align="right">Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {topEmployees.map((employee) => (
                  <tr key={employee.id}>
                    <Td>
                      <EntityCell
                        online={employee.isOnline}
                        name={employee.name}
                        href={`/employees/${employee.id}`}
                      />
                    </Td>
                    <Td muted>{employee.department ?? "-"}</Td>
                    <Td align="right" numeric>
                      {formatDuration(employee.activeSeconds)}
                    </Td>
                    <Td align="right" numeric muted>
                      {formatDuration(employee.idleSeconds)}
                    </Td>
                    <Td align="right" numeric>
                      {formatPercent(employee.productivityPercent)}
                    </Td>
                    <Td align="right" muted>
                      {formatRelative(employee.lastSeen)}
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
