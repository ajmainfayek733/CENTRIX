"use client";

import { usePathname, useRouter } from "next/navigation";
import { isoDate } from "@/lib/format";

const DAY_MS = 86_400_000;

const RANGES = [
  { value: "today", label: "Today", days: 1 },
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "15", label: "Last 15 days", days: 15 },
] as const;

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

export function OverviewRangeSelect({
  startDate,
  endDate,
}: {
  startDate: string;
  endDate: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  function onChange(value: string) {
    const range = RANGES.find((item) => item.value === value) ?? RANGES[0];
    const dates = rangeDates(range.days);
    router.push(`${pathname}?startDate=${dates.startDate}&endDate=${dates.endDate}`);
  }

  return (
    <label className="flex items-center gap-2 text-[12.5px] text-text-secondary">
      <span className="sr-only">Overview date range</span>
      <select
        aria-label="Overview date range"
        value={selectedRange(startDate, endDate)}
        onChange={(event) => onChange(event.target.value)}
        className="glass-control rounded-md px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none transition-colors focus:border-brand"
      >
        {RANGES.map((range) => (
          <option key={range.value} value={range.value}>
            {range.label}
          </option>
        ))}
      </select>
    </label>
  );
}
