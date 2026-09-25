"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { isoDate } from "@/lib/format";
import { ExportDepartmentPdfButton } from "./ExportDepartmentPdfButton";

const DAY_MS = 86_400_000;
const ALL_DEPARTMENTS = "";

const RANGES = [
  { value: "today", label: "Today", days: 1 },
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "15", label: "Last 15 days", days: 15 },
] as const;

const CONTROL_CLASS =
  "glass-control rounded-md px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none transition-colors focus:border-brand";

function rangeDates(days: number) {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

function selectedRange(startDate: string, endDate: string) {
  return (
    RANGES.find((range) => {
      const dates = rangeDates(range.days);
      return dates.startDate === startDate && dates.endDate === endDate;
    })?.value ?? "today"
  );
}

export function PerformanceFilters({
  startDate,
  endDate,
  departmentId,
  departmentName,
  departments,
}: {
  startDate: string;
  endDate: string;
  departmentId: string | null;
  departmentName: string | null;
  departments: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function push(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function onRangeChange(value: string) {
    const range = RANGES.find((item) => item.value === value) ?? RANGES[0];
    const dates = rangeDates(range.days);
    push({ startDate: dates.startDate, endDate: dates.endDate });
  }

  function onDepartmentChange(value: string) {
    push({ departmentId: value || null });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {departments.length > 0 && (
        <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
          <span className="sr-only">Department</span>
          <select
            aria-label="Department"
            value={departmentId ?? ALL_DEPARTMENTS}
            onChange={(event) => onDepartmentChange(event.target.value)}
            className={CONTROL_CLASS}
          >
            <option value={ALL_DEPARTMENTS}>All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
        <span className="sr-only">Date range</span>
        <select
          aria-label="Date range"
          value={selectedRange(startDate, endDate)}
          onChange={(event) => onRangeChange(event.target.value)}
          className={CONTROL_CLASS}
        >
          {RANGES.map((range) => (
            <option key={range.value} value={range.value}>
              {range.label}
            </option>
          ))}
        </select>
      </label>

      {departmentId && departmentName && (
        <ExportDepartmentPdfButton
          departmentId={departmentId}
          departmentName={departmentName}
          startDate={startDate}
          endDate={endDate}
        />
      )}
    </div>
  );
}
