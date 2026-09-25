import { apiGet, ApiError } from "@/lib/api-client";
import { formatDuration, formatPercent, isoDate } from "@/lib/format";
import {
  Card,
  PageHeader,
  StatTile,
  TableWrap,
  TABLE_CLASS,
  Th,
  Td,
  EntityCell,
  EmptyState,
} from "@/components/ui";
import { DonutChart } from "@/components/charts";
import { PerformanceFilters } from "./PerformanceFilters";
import { UsageLeaderboard } from "./UsageLeaderboard";
import { WorkplaceIntelligencePanel } from "./WorkplaceIntelligencePanel";
import type {
  ActivityMetrics,
  DepartmentReport,
  DepartmentSummary,
  Organization,
  Overview,
  Roster,
  RosterEmployee,
  Totals,
} from "@/types/api";

export const metadata = { title: "Performance - C E N T R I X" };
export const dynamic = "force-dynamic";

const TOP_BY_ACTIVE_LIMIT = 8;
const DAY_MS = 86_400_000;
const DEPARTMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type RankedPerson = {
  id: string;
  name: string;
  isOnline?: boolean;
  activeSeconds: number;
  productiveSeconds: number;
  productivityPercent: number;
};

function parseDepartmentId(raw: string | undefined): string | null {
  if (!raw || !DEPARTMENT_ID_PATTERN.test(raw)) return null;
  return raw;
}

function rankingLabel(startDate: string, endDate: string, today: string): string {
  const isToday = startDate === today && endDate === today;
  const selectedDays = Math.round((Date.parse(endDate) - Date.parse(startDate)) / DAY_MS) + 1;
  if (isToday) return "Today";
  if (selectedDays === 7) return "Last 7 days";
  if (selectedDays === 15) return "Last 15 days";
  return `${startDate} to ${endDate}`;
}

function topPerformer(people: RankedPerson[]): RankedPerson | null {
  const ranked = people.filter((person) => person.activeSeconds > 0);
  if (ranked.length === 0) return null;

  return ranked.reduce((best, person) => {
    if (person.productivityPercent > best.productivityPercent) return person;
    if (person.productivityPercent < best.productivityPercent) return best;
    if (person.productiveSeconds > best.productiveSeconds) return person;
    return best;
  });
}

async function loadDepartmentReport(
  departmentId: string,
  suffix: string,
): Promise<DepartmentReport | null> {
  try {
    return await apiGet<DepartmentReport>(
      `/v1/dashboard/reports/departments/${encodeURIComponent(departmentId)}${suffix}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function rankFromRoster(employees: RosterEmployee[]): RankedPerson[] {
  return employees.map((employee) => ({
    id: employee.id,
    name: employee.name,
    isOnline: employee.isOnline,
    activeSeconds: employee.activeSeconds,
    productiveSeconds: employee.productiveSeconds,
    productivityPercent: employee.productivityPercent,
  }));
}

function rankFromReport(report: DepartmentReport, roster: Roster): RankedPerson[] {
  const onlineById = new Map(roster.employees.map((employee) => [employee.id, employee.isOnline]));
  return report.members.map((member) => ({
    id: member.employee.id,
    name: member.employee.name,
    isOnline: onlineById.get(member.employee.id),
    activeSeconds: member.totals.activeSeconds,
    productiveSeconds: member.totals.productiveSeconds,
    productivityPercent: member.totals.productivityPercent,
  }));
}

function departmentRows(departments: DepartmentSummary[], roster: Roster) {
  return departments
    .map((department) => {
      const members = roster.employees.filter(
        (employee) => employee.department?.toLowerCase() === department.name.toLowerCase(),
      );
      const totals = members.reduce(
        (acc, employee) => {
          acc.activeSeconds += employee.activeSeconds;
          acc.idleSeconds += employee.idleSeconds;
          acc.productiveSeconds += employee.productiveSeconds;
          return acc;
        },
        { activeSeconds: 0, idleSeconds: 0, productiveSeconds: 0 },
      );
      const productivityPercent =
        totals.activeSeconds > 0
          ? Math.round((totals.productiveSeconds / totals.activeSeconds) * 1000) / 10
          : 0;
      return {
        id: department.id,
        name: department.name,
        headcount: members.length,
        ...totals,
        productivityPercent,
      };
    })
    .sort((a, b) => b.productivityPercent - a.productivityPercent || b.activeSeconds - a.activeSeconds);
}

function ActivityMetricsTile({ metrics }: { metrics: ActivityMetrics }) {
  const total = (metrics.keyCount ?? 0) + (metrics.mouseCount ?? 0);

  return (
    <div className="rounded-lg border border-glass-border bg-surface px-[18px] py-4 shadow-glass-sm">
      <p className="mb-[7px] text-[10px] font-medium uppercase tracking-[0.06em] text-text-tertiary">
        Activity
      </p>
      <div className="flex items-baseline gap-3">
        <div className="flex items-baseline gap-1">
          <span className="tnum text-[20px] font-semibold leading-none tracking-[-0.5px] text-text-primary">
            {total.toLocaleString()}
          </span>
          <span className="text-[10px] text-text-tertiary">Total</span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-[10px] font-medium text-text-tertiary">K</span>
          <span className="tnum text-[12px] font-medium text-text-primary">
            {(metrics.keyCount ?? 0).toLocaleString()}
          </span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-[10px] font-medium text-text-tertiary">M</span>
          <span className="tnum text-[12px] font-medium text-text-primary">
            {(metrics.mouseCount ?? 0).toLocaleString()}
          </span>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[9px] text-text-secondary">
        <span>
          ML&nbsp;
          <span className="tnum text-text-primary">
            {(metrics.mouseLeftKeyCount ?? 0).toLocaleString()}
          </span>
        </span>
        <span>
          MR&nbsp;
          <span className="tnum text-text-primary">
            {(metrics.mouseRightKeyCount ?? 0).toLocaleString()}
          </span>
        </span>
        <span>
          MM&nbsp;
          <span className="tnum text-text-primary">
            {(metrics.mouseMiddleKeyCount ?? 0).toLocaleString()}
          </span>
        </span>
        <span>
          MO&nbsp;
          <span className="tnum text-text-primary">
            {(metrics.mouseOtherKeyCount ?? 0).toLocaleString()}
          </span>
        </span>
      </div>
    </div>
  );
}

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ startDate?: string; endDate?: string; departmentId?: string }>;
}) {
  const params = await searchParams;
  const today = isoDate(new Date());
  const startDate = params.startDate ?? today;
  const endDate = params.endDate ?? today;
  const requestedDepartmentId = parseDepartmentId(params.departmentId);
  const query = new URLSearchParams({ startDate, endDate });
  const suffix = `?${query}`;

  const [overview, roster, organizations, departmentReport] = await Promise.all([
    apiGet<Overview>(`/v1/dashboard/reports/overview${suffix}`),
    apiGet<Roster>(`/v1/dashboard/reports/roster${suffix}`),
    apiGet<Organization[]>("/v1/dashboard/organizations").catch(() => [] as Organization[]),
    requestedDepartmentId
      ? loadDepartmentReport(requestedDepartmentId, suffix)
      : Promise.resolve(null),
  ]);

  const organization = organizations[0];
  const departments = organization
    ? await apiGet<DepartmentSummary[]>(
        `/v1/dashboard/organizations/${organization.id}/departments`,
      ).catch(() => [] as DepartmentSummary[])
    : [];

  const selectedDepartment =
    departmentReport?.department ??
    departments.find((department) => department.id === requestedDepartmentId) ??
    null;

  const people = departmentReport ? rankFromReport(departmentReport, roster) : rankFromRoster(roster.employees);
  const totals: Totals = departmentReport?.totals ?? overview.totals;
  const rangeLabel = rankingLabel(startDate, endDate, today);
  const performer = topPerformer(people);
  const topByActive = [...people]
    .filter((person) => person.activeSeconds > 0)
    .sort((a, b) => b.activeSeconds - a.activeSeconds)
    .slice(0, TOP_BY_ACTIVE_LIMIT);
  const comparison = departmentRows(departments, roster);
  const rangeQuery = `startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;

  return (
    <div className="space-y-3.5">
      <PageHeader
        title="Performance"
        subtitle={
          selectedDepartment
            ? `${selectedDepartment.name} - ${rangeLabel}`
            : `Productivity and activity ratings - ${rangeLabel}`
        }
        action={
          <PerformanceFilters
            startDate={startDate}
            endDate={endDate}
            departmentId={selectedDepartment?.id ?? null}
            departmentName={selectedDepartment?.name ?? null}
            departments={departments}
          />
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Team productive %"
          value={formatPercent(totals.productivityPercent)}
          hint="Of team active time this period"
        />
        <StatTile
          label="Top performer"
          value={performer?.name ?? "-"}
          hint={
            performer
              ? `${formatPercent(performer.productivityPercent)} productive share`
              : "No activity in this period"
          }
        />
        <StatTile
          label="Idle time"
          value={formatDuration(totals.idleSeconds)}
          hint="Across the team this period"
        />
        {departmentReport ? (
          <ActivityMetricsTile metrics={departmentReport.activityMetrics} />
        ) : (
          <StatTile
            label="Reporting"
            value={`${overview.employeesTracked} of ${overview.headcount}`}
            hint="Employees with activity data"
          />
        )}
      </div>

      {departmentReport && (
        <WorkplaceIntelligencePanel intelligence={departmentReport.workplaceIntelligence} />
      )}

      <div className="grid gap-3.5 xl:grid-cols-[1.5fr_1fr]">
        <Card title="Productivity distribution">
          <div className="py-2">
            <DonutChart
              caption={`Share of recorded time this period: productive ${formatPercent(totals.productivityPercent)} of active time`}
              slices={[
                { label: "Productive", value: totals.productiveSeconds, tone: "success" },
                { label: "Neutral", value: totals.neutralSeconds, tone: "neutral" },
                { label: "Unproductive", value: totals.unproductiveSeconds, tone: "warning" },
                { label: "Blacklisted", value: totals.blacklistedSeconds, tone: "danger" },
                { label: "Idle", value: totals.idleSeconds, tone: "brand" },
              ]}
            />
          </div>
        </Card>

        <Card title="Top by active time">
          {topByActive.length === 0 ? (
            <EmptyState message="No activity recorded in this period. Once an agent reports, ranking appears here." />
          ) : (
            <TableWrap>
              <table className={`${TABLE_CLASS} min-w-[420px]`}>
                <thead>
                  <tr>
                    <Th>Employee</Th>
                    <Th align="right">Active</Th>
                    <Th align="right">Productive</Th>
                    <Th align="right">Score</Th>
                  </tr>
                </thead>
                <tbody>
                  {topByActive.map((person) => (
                    <tr key={person.id}>
                      <Td>
                        <EntityCell
                          online={person.isOnline}
                          name={person.name}
                          href={`/employees/${person.id}`}
                        />
                      </Td>
                      <Td align="right" numeric>
                        {formatDuration(person.activeSeconds)}
                      </Td>
                      <Td align="right" numeric muted>
                        {formatDuration(person.productiveSeconds)}
                      </Td>
                      <Td align="right" numeric>
                        {formatPercent(person.productivityPercent)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      {departmentReport && (
        <div className="grid gap-3.5 lg:grid-cols-2">
          <Card title="Top applications">
            <UsageLeaderboard
              emptyMessage="No application time recorded in this period."
              items={departmentReport.topApps.map((app) => ({
                ...app,
                key: `${app.appName}-${app.productivityTag}`,
                name: app.appName ?? "Unknown",
              }))}
            />
          </Card>
          <Card title="Top websites">
            <UsageLeaderboard
              emptyMessage="No browsing recorded in this period."
              items={departmentReport.topDomains.map((site) => ({
                ...site,
                key: `${site.domain}-${site.productivityTag}`,
                name: site.domain,
              }))}
            />
          </Card>
        </div>
      )}

      {!departmentReport && departments.length > 0 && (
        <Card title="Departments">
          {comparison.every((row) => row.activeSeconds === 0) ? (
            <EmptyState message="No department activity in this period. Assign people to departments, then pick one above for the full report." />
          ) : (
            <TableWrap>
              <table className={`${TABLE_CLASS} min-w-[480px]`}>
                <thead>
                  <tr>
                    <Th>Department</Th>
                    <Th align="right">People</Th>
                    <Th align="right">Active</Th>
                    <Th align="right">Idle</Th>
                    <Th align="right">Score</Th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((row) => (
                    <tr key={row.id}>
                      <Td>
                        <EntityCell
                          name={row.name}
                          href={`/performance?${rangeQuery}&departmentId=${encodeURIComponent(row.id)}`}
                        />
                      </Td>
                      <Td align="right" numeric muted>
                        {row.headcount}
                      </Td>
                      <Td align="right" numeric>
                        {formatDuration(row.activeSeconds)}
                      </Td>
                      <Td align="right" numeric muted>
                        {formatDuration(row.idleSeconds)}
                      </Td>
                      <Td align="right" numeric>
                        {formatPercent(row.productivityPercent)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}
    </div>
  );
}
