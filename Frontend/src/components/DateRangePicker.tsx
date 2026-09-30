'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { isoDate } from '@/lib/format';

/**
 * Range filter. Pushes the selection into the URL rather than component state, so the server
 * component above re-renders with fresh data, the range survives a refresh, and a manager can
 * share a link to exactly what they were looking at.
 */
export function DateRangePicker({ startDate, endDate }: { startDate?: string; endDate?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function apply(next: { startDate?: string; endDate?: string }) {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }

    router.push(`${pathname}?${params}`);
  }

  function applyPreset(days: number) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    apply({ startDate: isoDate(start), endDate: isoDate(end) });
  }

  const inputClass =
    'glass-control rounded-md px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none transition-colors focus:border-brand';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {[
        { label: 'Today', days: 0 },
        { label: '7 days', days: 7 },
        { label: '30 days', days: 30 },
      ].map((preset) => (
        <button
          key={preset.label}
          type="button"
          onClick={() => applyPreset(preset.days)}
          className="glass-control rounded-md px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors hover:text-brand"
        >
          {preset.label}
        </button>
      ))}

      <input
        type="date"
        aria-label="Start date"
        value={startDate ?? ''}
        onChange={(e) => apply({ startDate: e.target.value, endDate })}
        className={inputClass}
      />
      <span className="text-[12.5px] text-text-tertiary">to</span>
      <input
        type="date"
        aria-label="End date"
        value={endDate ?? ''}
        onChange={(e) => apply({ startDate, endDate: e.target.value })}
        className={inputClass}
      />
    </div>
  );
}
