import {
  Card,
  PageHeader,
  StatTile,
  StatusDot,
  TableWrap,
  TABLE_CLASS,
  Th,
  Td,
} from "@/components/ui";
import { DonutChart } from "@/components/charts";
import { TemplateNotice } from "@/components/TemplateNotice";

export const metadata = { title: "Performance - C E N T R I X" };

/**
 * Productivity and activity ratings, laid out from the blueprint.
 *
 * The roster endpoint already returns per-employee productive/neutral/unproductive/blacklisted
 * seconds, so much of this could be derived rather than fetched. That derivation is deliberately
 * not written here - this commit is the layout, and inventing an aggregate on the client is how
 * two screens end up disagreeing about the same number.
 */

/** Invented. Generic names on purpose - see the note in TemplateNotice. */
const PLACEHOLDER_RANKING = [
  { name: "Employee A", active: "-", productive: "-", score: "-" },
  { name: "Employee B", active: "-", productive: "-", score: "-" },
  { name: "Employee C", active: "-", productive: "-", score: "-" },
];

export default function PerformancePage() {
  return (
    <div className="space-y-3.5">
      <PageHeader title="Performance" subtitle="Productivity and activity ratings" />

      <TemplateNotice endpoint="a team performance rollup endpoint" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Avg. productive %" value="-" hint="Team average this period" />
        <StatTile label="Top performer" value="-" hint="By productive share" />
        <StatTile label="Idle time" value="-" hint="Across active agents" />
        <StatTile label="Reporting" value="-" hint="Employees with data" />
      </div>

      <div className="grid gap-3.5 xl:grid-cols-[1.5fr_1fr]">
        <Card title="Productivity distribution">
          <div className="py-2">
            <DonutChart
              caption="Placeholder productivity distribution; no data is connected yet"
              slices={[
                { label: "Productive", value: 0, tone: "success" },
                { label: "Neutral", value: 0, tone: "neutral" },
                { label: "Unproductive", value: 0, tone: "warning" },
                { label: "Idle", value: 0, tone: "neutral" },
              ]}
            />
          </div>
        </Card>

        <Card title="Top by active time">
          <TableWrap>
            <table className={`${TABLE_CLASS} min-w-[420px]`}>
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th align="right">Active</Th>
                  <Th align="right">Productive</Th>
                  {/*
                    The blueprint renders this as a five-star rating. Kept as a column because it
                    is in the blueprint, but left unscored: no endpoint produces a score, and a
                    star rating of a person is a judgement the product would be asserting rather
                    than measuring. Worth settling before it is wired up.
                  */}
                  <Th align="right">Score</Th>
                </tr>
              </thead>
              <tbody>
                {PLACEHOLDER_RANKING.map((row) => (
                  <tr key={row.name}>
                    <Td>
                      <span className="flex items-center gap-2.5 font-medium">
                        <StatusDot online={false} />
                        {row.name}
                      </span>
                    </Td>
                    <Td align="right" numeric muted>
                      {row.active}
                    </Td>
                    <Td align="right" numeric muted>
                      {row.productive}
                    </Td>
                    <Td align="right" muted>
                      {row.score}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      </div>
    </div>
  );
}
