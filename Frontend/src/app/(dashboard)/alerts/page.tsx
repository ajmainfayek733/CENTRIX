import { apiGet } from '@/lib/api-client';
import { Card } from '@/components/ui';
import type { LogPage } from '@/components/LogScroller';
import type { AlertRow, UsbEventRow } from '@/types/api';
import { AlertsTable } from './AlertsTable';
import { UsbTable } from './UsbTable';

export const metadata = { title: 'Alerts · Employee Monitor' };
export const dynamic = 'force-dynamic';

/**
 * Both feeds render their first page on the server, so the tables are populated before any
 * JavaScript runs. Subsequent pages are fetched by the scroll windows themselves as the operator
 * reaches the end — this page never asks for the whole range.
 */
export default async function AlertsPage() {
  const [alerts, usb] = await Promise.all([
    apiGet<LogPage<AlertRow>>('/v1/dashboard/reports/alerts'),
    apiGet<LogPage<UsbEventRow> & { period: { start: string; end: string } }>(
      '/v1/dashboard/reports/usb-events'
    ),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Alerts &amp; device activity</h1>
        <p className="mt-0.5 text-sm text-text-secondary">
          Unresolved alerts and the removable-device audit trail. Both update as they happen.
        </p>
      </div>

      {/*
        The count is deliberately phrased as "showing N", not "N open alerts". Only the first
        page is loaded, so a total would be a number this page cannot know — and a wrong count on
        an alerts screen is worse than no count.
      */}
      <Card title={`Open alerts · showing ${alerts.rows.length}${alerts.hasMore ? '+' : ''}`}>
        <AlertsTable initial={alerts} />
      </Card>

      <Card title="USB devices · last 7 days">
        <UsbTable initial={usb} />
      </Card>
    </div>
  );
}
