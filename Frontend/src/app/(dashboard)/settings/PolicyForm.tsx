'use client';

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui';
import type { Policy } from '@/types/api';
import { updatePolicy, type PolicyFormValues } from './actions';

/**
 * The settings screen, split by who a setting acts on.
 *
 * THE DIVISION IS THE POINT: "screenshot interval" reprograms every agent in the building and
 * changes what is recorded about people; "screenshots per page" changes how many pictures this
 * browser downloads at once and nothing else. They used to sit in one undifferentiated list where
 * the only way to tell them apart was to already know. The three groups are:
 *
 *   1. Agent policy — runs on employee machines, changes what is collected.
 *   2. Dashboard    — read path only, invisible to agents and to employees.
 *   3. Advanced     — fleet-wide scale and data lifetime; collapsed, because a wrong value here
 *                     is felt on every device at once or deletes history permanently.
 */

function toFormValues(policy: Policy): PolicyFormValues {
  return {
    attendanceEnabled: policy.attendance.enabled,
    activityEnabled: policy.activity.enabled,
    idleThresholdSeconds: policy.activity.idleThresholdSeconds,
    appSessionEnabled: policy.appSession.enabled,
    browserMonitorEnabled: policy.browserMonitor.enabled,
    screenshotEnabled: policy.screenshot.enabled,
    screenshotIntervalSeconds: policy.screenshot.intervalSeconds,
    screenshotJpegQuality: policy.screenshot.jpegQuality,
    usbEnabled: policy.usb.enabled,
    usbAlertOnInsertion: policy.usb.alertOnInsertion,
    alertEnabled: policy.alert.enabled,
    alertIdleEnabled: policy.alert.idle.enabled,
    alertIdleNormalSeconds: policy.alert.idle.normalSeconds,
    alertIdleModerateSeconds: policy.alert.idle.moderateSeconds,
    alertIdleSevereSeconds: policy.alert.idle.severeSeconds,
    alertBlacklistEnabled: policy.alert.blacklistEnabled,
    alertOutsideWorkingHours: policy.alert.notifyOutsideWorkingHours,
    retentionDays: policy.retention.retentionDays,
    workingHoursStartLocal: policy.workingHours.startLocal,
    workingHoursEndLocal: policy.workingHours.endLocal,
    syncBatchIntervalSeconds: policy.sync.batchIntervalSeconds,
    syncMaxBatchSize: policy.sync.maxBatchSize,
    logPageSize: policy.logPageSize,
    screenshotPageSize: policy.screenshotPageSize,
    realtimeEnabled: policy.realtime.enabled,
    presenceHeartbeatSeconds: policy.realtime.heartbeatSeconds,
  };
}

/**
 * Input bounds, mirrored from the backend's Zod schema (organization.dto.ts).
 *
 * Duplicated deliberately: the server is the enforcement point, and these exist only so a bad
 * value is caught at the input rather than as a 400 after a round trip. A change there must be
 * made here too — a stricter server bound would otherwise appear as an unexplained save failure.
 */
const LIMITS = {
  idleThresholdMinutes: { min: 1, max: 60 },
  screenshotIntervalMinutes: { min: 1, max: 1440 },
  screenshotJpegQuality: { min: 10, max: 100 },
  retentionDays: { min: 1, max: 3650 },
  logPageSize: { min: 10, max: 500 },
  screenshotPageSize: { min: 3, max: 60 },
  syncMaxBatchSize: { min: 1, max: 500 },
  syncBatchIntervalSeconds: { min: 10, max: 3600 },
  presenceHeartbeatSeconds: { min: 5, max: 300 },
  idleLadderMinutes: { min: 1 },
} as const;

/** The form works in minutes; the policy stores seconds. */
const SECONDS_PER_MINUTE = 60;

export function PolicyForm({ organizationId, policy }: { organizationId: string; policy: Policy }) {
  const saved = toFormValues(policy);
  const [values, setValues] = useState<PolicyFormValues>(saved);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  // Whether anything is unsaved. Worth showing now that the form is three groups deep with one of
  // them collapsed: a changed value scrolled out of view is a changed value forgotten, and this
  // form reprograms every agent in the building.
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  function set<K extends keyof PolicyFormValues>(key: K, value: PolicyFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setStatus(null);
  }

  function save() {
    // The backend rejects a non-increasing escalation ladder with a 400. Checking here too
    // turns that into an inline message instead of a failed round trip.
    if (
      values.alertIdleNormalSeconds >= values.alertIdleModerateSeconds ||
      values.alertIdleModerateSeconds >= values.alertIdleSevereSeconds
    ) {
      setStatus('Idle thresholds must increase: normal < moderate < severe.');
      return;
    }

    startTransition(async () => {
      try {
        await updatePolicy(organizationId, values);
        // Connected agents are signalled immediately; the heartbeat is the fallback for any
        // that were offline, so the message describes the guarantee rather than the fast path.
        setStatus('Saved. Connected agents apply this now; others on their next heartbeat.');
      } catch {
        setStatus('Could not save. Check that the API is reachable.');
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card title="Agent policy">
        <GroupNote>
          What the software on employee machines collects and does. Changes here alter what is
          recorded about people, and every agent picks them up on its next heartbeat.
        </GroupNote>

        <div className="space-y-6">
          <Section title="Data collected">
            <Toggle
              label="Attendance"
              hint="First sign-in and last sign-out per day"
              checked={values.attendanceEnabled}
              onChange={(v) => set('attendanceEnabled', v)}
            />
            <Toggle
              label="Application tracking"
              hint="Foreground app and window title"
              checked={values.appSessionEnabled}
              onChange={(v) => set('appSessionEnabled', v)}
            />
            <Toggle
              label="Active / idle"
              hint="Split working time from inactivity"
              checked={values.activityEnabled}
              onChange={(v) => set('activityEnabled', v)}
            />
            <Toggle
              label="Website tracking"
              hint="Domains visited and time per site"
              checked={values.browserMonitorEnabled}
              onChange={(v) => set('browserMonitorEnabled', v)}
            />
            <Toggle
              label="USB devices"
              hint="Connection and removal only — never contents"
              checked={values.usbEnabled}
              onChange={(v) => set('usbEnabled', v)}
            />
            <Toggle
              label="Screenshots"
              hint="The most invasive setting. Off is the recommended default."
              checked={values.screenshotEnabled}
              onChange={(v) => set('screenshotEnabled', v)}
            />
          </Section>

          {/*
            Interval and quality are what decide the cost of screenshots — in storage, in bandwidth,
            and in how much of someone's day is photographed. Grouped with the toggle that governs
            them and disabled alongside it, so they cannot be tuned under the impression they are
            doing something while captures are off.
          */}
          <Section title="Screenshot capture">
            <NumberField
              label="Capture interval"
              unit="minutes"
              hint="How often a capture is taken while the employee is active"
              value={values.screenshotIntervalSeconds / SECONDS_PER_MINUTE}
              min={LIMITS.screenshotIntervalMinutes.min}
              max={LIMITS.screenshotIntervalMinutes.max}
              onChange={(v) => set('screenshotIntervalSeconds', v * SECONDS_PER_MINUTE)}
              disabled={!values.screenshotEnabled}
            />
            <NumberField
              label="Image quality"
              unit="JPEG quality"
              hint="Lower means smaller files and less storage. 70 keeps window titles readable; above about 85 the files grow quickly for little visible gain."
              value={values.screenshotJpegQuality}
              min={LIMITS.screenshotJpegQuality.min}
              max={LIMITS.screenshotJpegQuality.max}
              onChange={(v) => set('screenshotJpegQuality', v)}
              disabled={!values.screenshotEnabled}
            />
          </Section>

          <Section title="Active / idle">
            <NumberField
              label="Idle threshold"
              unit="minutes"
              hint="Inactivity beyond this is counted as idle rather than as working time"
              value={values.idleThresholdSeconds / SECONDS_PER_MINUTE}
              min={LIMITS.idleThresholdMinutes.min}
              max={LIMITS.idleThresholdMinutes.max}
              onChange={(v) => set('idleThresholdSeconds', v * SECONDS_PER_MINUTE)}
            />
          </Section>

          <Section title="Desktop alerts">
            <Toggle
              label="Alerts enabled"
              checked={values.alertEnabled}
              onChange={(v) => set('alertEnabled', v)}
            />
            <Toggle
              label="Idle escalation"
              hint="Warn as inactivity crosses each threshold"
              checked={values.alertIdleEnabled}
              onChange={(v) => set('alertIdleEnabled', v)}
            />
            <Toggle
              label="Blacklist warnings"
              hint="Warn on a blacklisted app or site"
              checked={values.alertBlacklistEnabled}
              onChange={(v) => set('alertBlacklistEnabled', v)}
            />
            <Toggle
              label="Alert on USB insertion"
              checked={values.usbAlertOnInsertion}
              onChange={(v) => set('usbAlertOnInsertion', v)}
            />
            <Toggle
              label="Notify outside working hours"
              hint="Off means no desktop popups on an employee's own time"
              checked={values.alertOutsideWorkingHours}
              onChange={(v) => set('alertOutsideWorkingHours', v)}
            />
          </Section>

          <Section title="Idle escalation ladder">
            <NumberField
              label="Normal"
              unit="minutes"
              value={values.alertIdleNormalSeconds / SECONDS_PER_MINUTE}
              min={LIMITS.idleLadderMinutes.min}
              disabled={!values.alertIdleEnabled}
              onChange={(v) => set('alertIdleNormalSeconds', v * SECONDS_PER_MINUTE)}
            />
            <NumberField
              label="Moderate"
              unit="minutes"
              value={values.alertIdleModerateSeconds / SECONDS_PER_MINUTE}
              min={LIMITS.idleLadderMinutes.min}
              disabled={!values.alertIdleEnabled}
              onChange={(v) => set('alertIdleModerateSeconds', v * SECONDS_PER_MINUTE)}
            />
            <NumberField
              label="Severe"
              unit="minutes"
              value={values.alertIdleSevereSeconds / SECONDS_PER_MINUTE}
              min={LIMITS.idleLadderMinutes.min}
              disabled={!values.alertIdleEnabled}
              onChange={(v) => set('alertIdleSevereSeconds', v * SECONDS_PER_MINUTE)}
            />
          </Section>

          <Section title="Working hours">
            <TimeField
              label="Start"
              value={values.workingHoursStartLocal}
              onChange={(v) => set('workingHoursStartLocal', v)}
            />
            <TimeField
              label="End"
              value={values.workingHoursEndLocal}
              onChange={(v) => set('workingHoursEndLocal', v)}
            />
          </Section>
        </div>
      </Card>

      <Card title="Dashboard">
        <GroupNote>
          How much this browser loads at a time. Read path only — nothing here changes what is
          collected, and no agent ever sees it.
        </GroupNote>

        <Section title="Page sizes">
          <NumberField
            label="Log rows per page"
            unit="rows"
            hint="Rows a log window loads at a time, and fetches again when scrolled to the end"
            value={values.logPageSize}
            min={LIMITS.logPageSize.min}
            max={LIMITS.logPageSize.max}
            onChange={(v) => set('logPageSize', v)}
          />
          <NumberField
            label="Screenshots per page"
            unit="captures"
            hint="Kept far below the log page size: each one is a full-size image the browser downloads and decodes, not a row of text. 12 fills the grid four rows deep."
            value={values.screenshotPageSize}
            min={LIMITS.screenshotPageSize.min}
            max={LIMITS.screenshotPageSize.max}
            onChange={(v) => set('screenshotPageSize', v)}
          />
        </Section>
      </Card>

      {/*
        Collapsed by default, and not because these settings are obscure — because each is felt
        across the whole fleet at once, or deletes history that cannot be recovered. They belong on
        this screen (the right value depends on fleet size and on the retention the business
        committed to, neither of which waits for a deploy) but not in the path of someone who came
        to turn screenshots off.
      */}
      <AdvancedGroup>
        <Section title="Retention">
          <NumberField
            label="Data retention"
            unit="days"
            hint="Records older than this are deleted permanently. Lowering it destroys history that has already been collected."
            value={values.retentionDays}
            min={LIMITS.retentionDays.min}
            max={LIMITS.retentionDays.max}
            onChange={(v) => set('retentionDays', v)}
          />
        </Section>

        <Section title="Sync">
          <NumberField
            label="Events per batch"
            unit="events"
            hint="Smaller batches commit faster and hold locks for less time. 100 suits 30-100 devices."
            value={values.syncMaxBatchSize}
            min={LIMITS.syncMaxBatchSize.min}
            max={LIMITS.syncMaxBatchSize.max}
            onChange={(v) => set('syncMaxBatchSize', v)}
          />
          <NumberField
            label="Sync interval"
            unit="seconds"
            hint="How often an agent drains its queue when nothing is forcing it sooner"
            value={values.syncBatchIntervalSeconds}
            min={LIMITS.syncBatchIntervalSeconds.min}
            max={LIMITS.syncBatchIntervalSeconds.max}
            onChange={(v) => set('syncBatchIntervalSeconds', v)}
          />
        </Section>

        <Section title="Realtime">
          <Toggle
            label="Realtime updates"
            hint="Off falls back to polling — data still arrives, just not instantly"
            checked={values.realtimeEnabled}
            onChange={(v) => set('realtimeEnabled', v)}
          />
          <NumberField
            label="Presence heartbeat"
            unit="seconds"
            hint="How often an agent proves it is alive. Drives 'Active now'; a device goes grey after two and a half missed beats."
            value={values.presenceHeartbeatSeconds}
            min={LIMITS.presenceHeartbeatSeconds.min}
            max={LIMITS.presenceHeartbeatSeconds.max}
            disabled={!values.realtimeEnabled}
            onChange={(v) => set('presenceHeartbeatSeconds', v)}
          />
        </Section>
      </AdvancedGroup>

      {/*
        One save for all three groups, pinned to the bottom of the viewport. The form is now taller
        than a screen and one group is collapsed, so a button that scrolled away with the first card
        would strand changes made in the last one.
      */}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-background/90 px-1 py-3 backdrop-blur">
        {status && <span className="mr-auto text-xs text-text-secondary">{status}</span>}
        {!status && dirty && <span className="mr-auto text-xs text-warning">Unsaved changes</span>}
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-contrast transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

/** One line under a card's heading saying who the settings inside it act on. */
function GroupNote({ children }: { children: React.ReactNode }) {
  return <p className="mb-5 text-xs text-text-secondary">{children}</p>;
}

/**
 * The critical group, collapsed.
 *
 * A native `<details>` rather than a state toggle: open/closed is markup here, the browser gives
 * the keyboard and screen-reader behaviour for free, and browsers that expand on find-in-page can
 * still surface the fields inside.
 */
function AdvancedGroup({ children }: { children: React.ReactNode }) {
  return (
    <details className="group rounded-lg border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          Advanced
        </h2>
        <span className="hidden text-xs text-text-secondary sm:block">
          Fleet-wide scale and data lifetime. A wrong value affects every device, or deletes history
          permanently.
        </span>
        <svg
          viewBox="0 0 24 24"
          className="ml-auto size-4 shrink-0 text-text-secondary transition-transform group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </summary>
      <div className="space-y-6 border-t border-border p-5">{children}</div>
    </details>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
        {title}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5 transition-colors hover:bg-surface-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 accent-[var(--brand)]"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-text-secondary">{hint}</span>}
      </span>
    </label>
  );
}

function NumberField({
  label,
  unit,
  hint,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  unit: string;
  /** One line explaining what moving this number actually costs or buys. */
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={`block ${disabled ? 'opacity-50' : ''}`}>
      <span className="mb-1 block text-xs text-text-secondary">{label}</span>
      {hint && <span className="mb-1 block text-xs text-text-secondary/80">{hint}</span>}
      <span className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(e) => {
            const next = Number(e.target.value);
            // An empty input parses to NaN, which would post garbage to the API.
            if (Number.isFinite(next)) onChange(next);
          }}
          className="tnum w-24 rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand"
        />
        <span className="text-xs text-text-secondary">{unit}</span>
      </span>
    </label>
  );
}

function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-text-secondary">{label}</span>
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="tnum rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand"
      />
    </label>
  );
}
