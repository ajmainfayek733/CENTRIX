import { PageHeader, StatTile } from '@/components/ui';
import { TemplateNotice } from '@/components/TemplateNotice';

export const metadata = { title: 'Departments - Employee Monitor' };

/**
 * Team structure and headcount, laid out from the blueprint.
 *
 * Static by design: there is no departments endpoint yet, so this fetches nothing and holds no
 * `dynamic` directive. When the API lands, this becomes an async server component reading
 * through `apiGet`, and the placeholder constant below goes with it.
 */

/** Invented. Generic names on purpose - see the note in TemplateNotice. */
const PLACEHOLDER_DEPARTMENTS = [
  { name: 'Department A', lead: 'Lead: not set', employees: 0, devices: 0 },
  { name: 'Department B', lead: 'Lead: not set', employees: 0, devices: 0 },
  { name: 'Department C', lead: 'Lead: not set', employees: 0, devices: 0 },
  { name: 'Unassigned', lead: 'No members yet', employees: 0, devices: 0 },
];

export default function DepartmentsPage() {
  return (
    <div className="space-y-3.5">
      <PageHeader title="Departments" subtitle="Team structure and headcount" />

      <TemplateNotice endpoint="a department rollup endpoint" />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Total departments" value="-" />
        <StatTile label="Largest team" value="-" hint="By headcount" />
        <StatTile label="Active devices" value="-" hint="Across all departments" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {PLACEHOLDER_DEPARTMENTS.map((department) => (
          <div
            key={department.name}
            className="rounded-lg border border-glass-border bg-surface p-[18px] shadow-glass-sm transition-transform duration-200 ease-out hover:-translate-y-0.5"
          >
            <p className="text-[14.5px] font-semibold text-text-primary">{department.name}</p>
            <p className="mt-[3px] text-[12.5px] text-text-secondary">{department.lead}</p>

            <dl className="mt-3 flex gap-[18px]">
              <div>
                <dd className="tnum text-lg font-semibold text-text-primary">
                  {department.employees || '-'}
                </dd>
                <dt className="mt-0.5 text-[11px] text-text-tertiary">Employees</dt>
              </div>
              <div>
                <dd className="tnum text-lg font-semibold text-text-primary">
                  {department.devices || '-'}
                </dd>
                <dt className="mt-0.5 text-[11px] text-text-tertiary">Devices</dt>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
