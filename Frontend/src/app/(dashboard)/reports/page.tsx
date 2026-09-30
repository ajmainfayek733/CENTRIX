import { apiGet } from "@/lib/api-client";
import { PageHeader } from "@/components/ui";
import type { Roster, Organization, DepartmentSummary } from "@/types/api";
import { ReportGenerator } from "./ReportGenerator";

export const metadata = { title: "Reports - C E N T R I X" };
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const [roster, organizations] = await Promise.all([
    apiGet<Roster>("/v1/dashboard/reports/roster").catch(() => ({
      period: { start: "", end: "" },
      employees: [],
    })),
    apiGet<Organization[]>("/v1/dashboard/organizations").catch(() => []),
  ]);

  const organization = organizations[0];
  const departments = organization
    ? await apiGet<DepartmentSummary[]>(
        `/v1/dashboard/organizations/${organization.id}/departments`,
      ).catch(() => [])
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports & Analytics Hub"
        subtitle="Generate executive PDF reports, export team logs, and download audit data"
      />

      <ReportGenerator employees={roster.employees} departments={departments} />
    </div>
  );
}
