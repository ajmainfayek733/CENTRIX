'use client';

import { useRealtime } from '@/components/RealtimeProvider';
import { formatDuration, formatPercent } from '@/lib/format';
import { StatTile } from '@/components/ui';

/**
 * Figures that move as telemetry lands, without asking the server anything.
 *
 * Each takes the server-rendered value as its baseline and adds what has been ingested since the
 * page was built. The addend arrives with the ingest event itself - the backend aggregated the
 * batch once, inside the write transaction, and pushed the result - so no viewer recomputes it
 * and no viewer waits for a round trip.
 *
 * The baseline is not decoration. It is what makes this correct across a reconnect: the deltas
 * are cleared whenever the page refetches, so the two never overlap, and a client that missed
 * events while disconnected is corrected by the refetch rather than drifting forever.
 */

export function LiveActiveTimeTile({ baseline }: { baseline: number }) {
  const { liveDelta } = useRealtime();
  const seconds = baseline + liveDelta.activeSeconds;

  return (
    <StatTile
      label="Team active time"
      value={formatDuration(seconds)}
      hint={liveDelta.activeSeconds > 0 ? `+${formatDuration(liveDelta.activeSeconds)} just now` : 'Across the period'}
    />
  );
}

/**
 * Productivity share, recomputed from live totals rather than adjusted.
 *
 * A percentage cannot be updated by adding a delta to it - the denominator moves too. Both parts
 * are tracked, so this recomputes from numerator and denominator, which is the only way to keep
 * it honest as work arrives.
 */
export function LiveProductivityTile({
  baselineActive,
  baselineProductive,
}: {
  baselineActive: number;
  baselineProductive: number;
}) {
  const { liveDelta } = useRealtime();

  const active = baselineActive + liveDelta.activeSeconds;
  const productive = baselineProductive + liveDelta.productiveSeconds;
  const percent = active > 0 ? Math.round((productive / active) * 1000) / 10 : 0;

  return (
    <StatTile
      label="Productive share"
      value={formatPercent(percent)}
      hint="Of active time"
      tone={percent >= PRODUCTIVE_TARGET_PERCENT ? 'success' : 'default'}
    />
  );
}

/**
 * Threshold at which the productive share is shown in the brand colour.
 *
 * A presentation cue only - nothing decides anything on it. Half of active time being productive
 * is a deliberately unremarkable bar, because this tile is glanced at, not judged by.
 */
const PRODUCTIVE_TARGET_PERCENT = 50;

/** One employee's active time in a roster row, moving as their workstation reports. */
export function LiveEmployeeActiveTime({
  employeeId,
  baseline,
}: {
  employeeId: string;
  baseline: number;
}) {
  const { liveDeltaByEmployee } = useRealtime();
  const delta = liveDeltaByEmployee.get(employeeId);

  return <>{formatDuration(baseline + (delta?.activeSeconds ?? 0))}</>;
}
