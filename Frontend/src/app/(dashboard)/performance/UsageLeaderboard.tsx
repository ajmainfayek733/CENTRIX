import { formatDuration } from "@/lib/format";
import { EmptyState, TagBadge } from "@/components/ui";
import type { UsageTotals } from "@/types/api";

export function UsageLeaderboard({
  items,
  emptyMessage,
}: {
  items: Array<UsageTotals & { key: string; name: string }>;
  emptyMessage: string;
}) {
  if (items.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  return (
    <ul className="-my-2 divide-y divide-border">
      {items.map((item) => (
        <li
          key={item.key}
          className="flex items-start justify-between gap-4 py-2.5 text-[13.5px]"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-text-primary" title={item.name}>
                {item.name}
              </span>
              <TagBadge tag={item.productivityTag} />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-text-secondary">
              {item.productiveSeconds > 0 && (
                <span className="inline-flex items-center gap-1.5" title="Productive">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-success-vivid" aria-hidden />
                  <span className="tnum font-medium text-text-primary">
                    {formatDuration(item.productiveSeconds)}
                  </span>
                </span>
              )}
              {item.neutralSeconds > 0 && (
                <span className="inline-flex items-center gap-1.5" title="Neutral">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-dot" aria-hidden />
                  <span className="tnum font-medium text-text-primary">
                    {formatDuration(item.neutralSeconds)}
                  </span>
                </span>
              )}
              {item.unproductiveSeconds > 0 && (
                <span className="inline-flex items-center gap-1.5" title="Unproductive">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-hidden />
                  <span className="tnum font-medium text-text-primary">
                    {formatDuration(item.unproductiveSeconds)}
                  </span>
                </span>
              )}
              {item.blacklistedSeconds > 0 && (
                <span className="inline-flex items-center gap-1.5" title="Blacklisted">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-danger" aria-hidden />
                  <span className="tnum font-medium text-danger">
                    {formatDuration(item.blacklistedSeconds)}
                  </span>
                </span>
              )}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <span className="tnum block text-[13.5px] font-semibold text-text-primary">
              {formatDuration(item.seconds)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
