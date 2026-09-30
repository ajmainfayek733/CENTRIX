import { apiGet } from "@/lib/api-client";
import { formatDuration, formatPercent, formatRelative } from "@/lib/format";
import { getSessionUser } from "@/lib/session";
import {
  Card,
  PageHeader,
  TableWrap,
  TABLE_CLASS,
  Th,
  Td,
  EntityCell,
  EmptyState,
  ProductivityBar,
} from "@/components/ui";
import type { DepartmentSummary, Organization, Roster } from "@/types/api";
import { EmployeeBulkForm } from "./EmployeeBulkForm";
import { EmployeeImport } from "./EmployeeImport";

export const metadata = { title: "Employees - C E N T R I X" };
export const dynamic = "force-dynamic";

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ startDate?: string; endDate?: string }>;
}) {
  const params = await searchParams;

  const query = new URLSearchParams();
  if (params.startDate) query.set("startDate", params.startDate);
  if (params.endDate) query.set("endDate", params.endDate);
  const suffix = query.size > 0 ? `?${query}` : "";

  const [roster, user] = await Promise.all([
    apiGet<Roster>(`/v1/dashboard/reports/roster${suffix}`),
    getSessionUser(),
  ]);

  const isAdmin = user?.role === "super_admin";

  // Only admins can import, and the endpoint needs an organization id. Single-site deployment,
  // so the first organization is the one being administered - same assumption as Settings.
  const organizations = isAdmin ? await apiGet<Organization[]>("/v1/dashboard/organizations") : [];
  const organizationId = organizations[0]?.id;

  // Departments are optional: a failed or empty fetch just means new employees start unassigned.
  const departments = organizationId
    ? await apiGet<DepartmentSummary[]>(`/v1/dashboard/organizations/${organizationId}/departments`).catch(
        () => [] as DepartmentSummary[],
      )
    : [];

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle={`${roster.employees.length} tracked - ${new Date(
          roster.period.start,
        ).toLocaleDateString()} to ${new Date(roster.period.end).toLocaleDateString()}`}
      />

      {organizationId && (
        <div className="mb-4 space-y-3">
          <div className="flex flex-wrap items-start gap-2">
            <EmployeeBulkForm
              organizationId={organizationId}
              departments={departments.map(({ id, name }) => ({ id, name }))}
            />
            {/* <EmployeeImport organizationId={organizationId} /> */}
          </div>
        </div>
      )}

      <Card>
        {roster.employees.length === 0 ? (
          <EmptyState message="No employees yet. Use 'Add employees' or 'Import roster' to add them, then assign each enrolled device to a person on the Devices screen." />
        ) : (
          <TableWrap>
            <table className={`${TABLE_CLASS} min-w-[820px]`}>
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Department</Th>
                  <Th align="right">Devices</Th>
                  <Th align="right">Active</Th>
                  <Th align="right">Idle</Th>
                  <Th align="right">Productive</Th>
                  <Th>Mix</Th>
                  <Th align="right">Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {roster.employees.map((employee) => (
                  <tr key={employee.id}>
                    <Td>
                      <EntityCell
                        online={employee.isOnline}
                        name={employee.name}
                        sub={employee.email}
                        href={`/employees/${employee.id}`}
                      />
                    </Td>
                    <Td muted>{employee.department ?? "-"}</Td>
                    <Td align="right" numeric muted>
                      {employee.deviceCount}
                    </Td>
                    <Td align="right" numeric>
                      {formatDuration(employee.activeSeconds)}
                    </Td>
                    <Td align="right" numeric muted>
                      {formatDuration(employee.idleSeconds)}
                    </Td>
                    <Td align="right" numeric>
                      {formatPercent(employee.productivityPercent)}
                    </Td>
                    <Td>
                      <div className="w-24">
                        <ProductivityBar
                          productive={employee.productiveSeconds}
                          unproductive={employee.unproductiveSeconds}
                          neutral={employee.neutralSeconds}
                          blacklisted={employee.blacklistedSeconds}
                          size="sm"
                        />
                      </div>
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
