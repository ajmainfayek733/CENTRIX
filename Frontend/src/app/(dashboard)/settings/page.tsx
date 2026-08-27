import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api-client";
import { getSessionUser } from "@/lib/session";
import { Card, PageHeader, Notice, EmptyState } from "@/components/ui";
import type { CategoryRow, Organization, Policy } from "@/types/api";
import { PolicyForm } from "./PolicyForm";
import { CategoryEditor } from "./CategoryEditor";

export const metadata = { title: "Settings - C E N T R I X" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getSessionUser();

  // The proxy hides the nav link; this is the actual gate for anyone typing the URL. The
  // backend rejects non-admin writes regardless.
  if (user?.role !== "super_admin") redirect("/overview");

  const organizations = await apiGet<Organization[]>("/v1/dashboard/organizations");

  if (organizations.length === 0) {
    return (
      <Card title="Settings">
        <EmptyState message="No organization exists yet. Create one via POST /v1/dashboard/organizations to get an enrollment token for the agent installer." />
      </Card>
    );
  }

  // Single-office deployment (spec section 1: 30 workstations, one site), so the first
  // organization is the one being configured.
  const organization = organizations[0];

  // Categories are fetched separately rather than read off the policy document: the policy
  // is shaped for the agent, which has no use for row ids, and the editor needs them to
  // delete a rule.
  const [policy, categories] = await Promise.all([
    apiGet<Policy>(`/v1/dashboard/organizations/${organization.id}/policy`),
    apiGet<CategoryRow[]>(`/v1/dashboard/organizations/${organization.id}/categories`),
  ]);

  return (
    <div className="space-y-3.5">
      <PageHeader
        title="Settings"
        subtitle={`${organization.name} - policy version ${policy.version}`}
      />

      <Notice>
        Saving any change increments the policy version. Agents apply it on their next heartbeat,
        and employees are asked to acknowledge the updated monitoring notice.
      </Notice>

      <PolicyForm organizationId={organization.id} policy={policy} />
      <CategoryEditor organizationId={organization.id} categories={categories} />
    </div>
  );
}
