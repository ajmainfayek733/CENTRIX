import { apiGet } from "@/lib/api-client";
import { getSessionUser } from "@/lib/session";
import { PageHeader, StatTile, Card, EmptyState } from "@/components/ui";
import type { Organization, DepartmentSummary, Roster } from "@/types/api";
import { DepartmentManager } from "./DepartmentManager";

export const metadata = { title: "Departments - C E N T R I X" };
export const dynamic = "force-dynamic";

export default async function DepartmentsPage() {
  const [user, organizations, roster] = await Promise.all([
    getSessionUser(),
    apiGet<Organization[]>("/v1/dashboard/organizations").catch(() => []),
    apiGet<Roster>("/v1/dashboard/reports/roster").catch(() => ({
      period: { start: "", end: "" },
      employees: [],
    })),
  ]);

  const organization = organizations[0];
  if (!organization) {
    return (
      <div className="space-y-3.5">
        <PageHeader title="Departments" subtitle="Team structure and headcount" />
        <Card>
          <EmptyState message="No organization found. Please enroll devices or configure the organization first." />
        </Card>
      </div>
    );
  }

  const departments = await apiGet<DepartmentSummary[]>(
    `/v1/dashboard/organizations/${organization.id}/departments`,
  ).catch(() => []);

  const totalEmployees = roster.employees.length;
  const assignedEmployees = roster.employees.filter((e) => !!e.department).length;
  const unassignedEmployees = totalEmployees - assignedEmployees;

  // Largest team calculation
  const deptCounts = departments.map((d) => ({
    name: d.name,
    count: roster.employees.filter((e) => e.department?.toLowerCase() === d.name.toLowerCase())
      .length,
  }));
  const largestTeam = deptCounts.sort((a, b) => b.count - a.count)[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Departments"
        subtitle={`${organization.name} - Team organization & department productivity rules`}
      />

      {/* Headline Stats */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Total departments"
          value={departments.length}
          hint={`${assignedEmployees} of ${totalEmployees} employees assigned`}
        />
        <StatTile
          label="Largest team"
          value={largestTeam && largestTeam.count > 0 ? largestTeam.name : "None yet"}
          hint={
            largestTeam && largestTeam.count > 0
              ? `${largestTeam.count} member(s)`
              : "No assigned members"
          }
        />
        <StatTile
          label="Unassigned staff"
          value={unassignedEmployees}
          hint="Employees awaiting department assignment"
          tone={unassignedEmployees > 0 ? "warning" : "success"}
        />
      </div>

      {/* Main Department Interactive Workspace */}
      <DepartmentManager
        organizationId={organization.id}
        departments={departments}
        allEmployees={roster.employees}
        userRole={user?.role}
      />
    </div>
  );
}
