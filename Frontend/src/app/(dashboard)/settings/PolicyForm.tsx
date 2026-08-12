'use client';

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui';
import type { Policy } from '@/types/api';
import { updatePolicy, type PolicyFormValues } from './actions';

function toFormValues(policy: Policy): PolicyFormValues {
  return {
    attendanceEnabled: policy.attendance.enabled,
    activityEnabled: policy.activity.enabled,
    idleThresholdSeconds: policy.activity.idleThresholdSeconds,
    appSessionEnabled: policy.appSession.enabled,
    browserMonitorEnabled: policy.browserMonitor.enabled,
    screenshotEnabled: policy.screenshot.enabled,
    screenshotIntervalSeconds: policy.screenshot.intervalSeconds,
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
  };
}

export function PolicyForm({ organizationId, policy }: { organizationId: string; policy: Policy }) {
  const [values, setValues] = useState<PolicyFormValues>(() => toFormValues(policy));
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

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
        setStatus('Saved. Agents will apply this on their next heartbeat.');
      } catch {
        setStatus('Could not save. Check that the API is reachable.');
      }
    });
  }

  return (
    <Card
      title="Monitoring policy"
      action={
        <div className="flex items-center gap-3">
          {status && <span className="text-xs text-text-secondary">{status}</span>}
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-contrast transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Savingâ€¦' : 'Save changes'}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        <Section title="Collection">
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
            hint="Connection and removal only â€” never contents"
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

        <Section title="Thresholds">
          <NumberField
            label="Idle threshold"
            unit="minutes"
            value={values.idleThresholdSeconds / 60}
            min={1}
            max={60}
            onChange={(v) => set('idleThresholdSeconds', v * 60)}
          />
          <NumberField
            label="Screenshot interval"
            unit="minutes"
            value={values.screenshotIntervalSeconds / 60}
            min={1}
            max={1440}
            onChange={(v) => set('screenshotIntervalSeconds', v * 60)}
            disabled={!values.screenshotEnabled}
          />
          <NumberField
            label="Data retention"
            unit="days"
            value={values.retentionDays}
            min={1}
            max={3650}
            onChange={(v) => set('retentionDays', v)}
          />
        </Section>

        <Section title="Alerts">
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
            value={values.alertIdleNormalSeconds / 60}
            min={1}
            onChange={(v) => set('alertIdleNormalSeconds', v * 60)}
          />
          <NumberField
            label="Moderate"
            unit="minutes"
            value={values.alertIdleModerateSeconds / 60}
            min={1}
            onChange={(v) => set('alertIdleModerateSeconds', v * 60)}
          />
          <NumberField
            label="Severe"
            unit="minutes"
            value={values.alertIdleSevereSeconds / 60}
            min={1}
            onChange={(v) => set('alertIdleSevereSeconds', v * 60)}
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
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">{title}</h3>
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
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={`block ${disabled ? 'opacity-50' : ''}`}>
      <span className="mb-1 block text-xs text-text-secondary">{label}</span>
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
