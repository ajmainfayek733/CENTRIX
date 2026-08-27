import {
  Users,
  CalendarDays,
  Monitor,
  Bell,
  ChartColumn,
  Building2,
  type LucideIcon,
} from "lucide-react";
import { PageHeader, Button } from "@/components/ui";
import { TemplateNotice } from "@/components/TemplateNotice";

export const metadata = { title: "Reports - C E N T R I X" };

/**
 * The report catalogue, laid out from the blueprint.
 *
 * Nothing here downloads anything. There is no report-generation endpoint, and a Download button
 * that silently does nothing is worse on this screen than on most - someone will click it,
 * assume a file is coming, and act on its absence. So every button is genuinely disabled and
 * says why, rather than looking live and failing quietly.
 */

const REPORTS: { title: string; description: string; format: string; icon: LucideIcon }[] = [
  {
    title: "Employee activity",
    description: "Active, idle and productive time per employee for the selected period.",
    format: "PDF",
    icon: Users,
  },
  {
    title: "Attendance summary",
    description: "Daily check-in / check-out and presence overview.",
    format: "Excel",
    icon: CalendarDays,
  },
  {
    title: "Device inventory",
    description: "Enrolled devices, OS versions, agent status and assignment.",
    format: "PDF",
    icon: Monitor,
  },
  {
    title: "Alerts & USB log",
    description: "All alerts and removable device connect/disconnect events.",
    format: "Excel",
    icon: Bell,
  },
  {
    title: "Productivity mix",
    description: "Productive, neutral, unproductive, blacklisted and idle breakdown.",
    format: "PDF",
    icon: ChartColumn,
  },
  {
    title: "Department summary",
    description: "Headcount, devices and activity aggregated by department.",
    format: "Excel",
    icon: Building2,
  },
];

export default function ReportsPage() {
  return (
    <div className="space-y-3.5">
      <PageHeader title="Reports" subtitle="Generate and download monitoring reports" />

      <TemplateNotice endpoint="a report generation endpoint" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {REPORTS.map((report) => {
          const Icon = report.icon;

          return (
            <div
              key={report.title}
              className="flex flex-col rounded-lg border border-glass-border bg-surface p-5 shadow-glass-sm transition-[transform,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-border-strong"
            >
              <span
                className="mb-[11px] grid size-[38px] place-items-center rounded-md bg-brand-soft text-brand"
                aria-hidden
              >
                <Icon className="size-[18px]" strokeWidth={1.75} />
              </span>

              <p className="text-sm font-semibold text-text-primary">{report.title}</p>
              <p className="mt-1.5 mb-3 flex-1 text-[12.5px] leading-relaxed text-text-secondary">
                {report.description}
              </p>

              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled
                className="self-start"
                title="Report generation is not available yet"
              >
                Download {report.format}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
