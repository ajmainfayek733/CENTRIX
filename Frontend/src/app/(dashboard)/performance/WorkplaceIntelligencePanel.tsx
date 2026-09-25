import { formatDuration, formatPercent } from "@/lib/format";
import { Card, StatTile } from "@/components/ui";
import type { WorkplaceIntelligence } from "@/types/api";

type TileTone = "default" | "brand" | "success" | "warning" | "danger";

const SWITCH_TONE: Record<WorkplaceIntelligence["contextSwitching"]["state"], TileTone> = {
  "Low Friction": "success",
  "Moderate Switching": "warning",
  "High Fragmentation": "danger",
};

const BURNOUT_TONE: Record<WorkplaceIntelligence["burnoutRisk"]["level"], TileTone> = {
  "Low Risk": "success",
  "Moderate Risk": "warning",
  "High Risk": "danger",
};

export function WorkplaceIntelligencePanel({
  intelligence,
}: {
  intelligence: WorkplaceIntelligence;
}) {
  const { deepWork, contextSwitching, collaborationVsMaker, burnoutRisk, executiveInsights } =
    intelligence;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Deep work"
          value={formatPercent(deepWork.scorePercent)}
          hint={`${formatDuration(deepWork.totalSeconds)} across ${deepWork.sessionCount} blocks`}
        />
        <StatTile
          label="Context switching"
          value={`${contextSwitching.switchesPerHour} / hr`}
          hint={contextSwitching.state}
          tone={SWITCH_TONE[contextSwitching.state]}
        />
        <StatTile
          label="Maker share"
          value={formatPercent(collaborationVsMaker.makerPercent)}
          hint={collaborationVsMaker.ratio}
        />
        <StatTile
          label="Burnout risk"
          value={burnoutRisk.level}
          hint={`${burnoutRisk.overtimeDays} overtime days, ${burnoutRisk.lateNightSessionsCount} late sessions`}
          tone={BURNOUT_TONE[burnoutRisk.level]}
        />
      </div>

      {(executiveInsights.length > 0 || burnoutRisk.narrative || contextSwitching.description) && (
        <Card title="Workplace insights">
          <p className="text-[13.5px] text-text-secondary">{contextSwitching.description}</p>
          <p className="mt-2 text-[13.5px] text-text-secondary">{burnoutRisk.narrative}</p>
          {executiveInsights.length > 0 && (
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[13.5px] text-text-primary">
              {executiveInsights.map((insight) => (
                <li key={insight}>{insight}</li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
