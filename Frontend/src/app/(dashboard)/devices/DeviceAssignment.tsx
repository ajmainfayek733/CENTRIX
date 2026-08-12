'use client';

import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui';
import { assignDevice } from './actions';

export interface AssignableEmployee {
  id: string;
  name: string;
  department: string | null;
}

/**
 * Attaches a self-enrolled device to a real employee.
 *
 * Devices mint their own credential and park on the org's "Unassigned Devices" placeholder, so
 * this is the only step in enrollment that needs a human. Until it happens the telemetry is
 * stored but attributed to the placeholder, which means it never reaches per-employee reports -
 * so an unassigned device is not a cosmetic gap, it is data that cannot be read.
 */
export function DeviceAssignment({
  deviceId,
  employees,
  currentEmployeeId,
  isUnassigned,
}: {
  deviceId: string;
  employees: AssignableEmployee[];
  currentEmployeeId: string;
  isUnassigned: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Tracks the pending choice so the select does not snap back to the old value while the
  // server action is in flight and the page revalidates.
  const [selected, setSelected] = useState(isUnassigned ? '' : currentEmployeeId);

  function onChange(employeeId: string) {
    if (!employeeId || employeeId === selected) return;

    setSelected(employeeId);
    setError(null);

    startTransition(async () => {
      try {
        await assignDevice(deviceId, employeeId);
      } catch {
        setError('Could not assign');
        setSelected(isUnassigned ? '' : currentEmployeeId);
      }
    });
  }

  if (employees.length === 0) {
    return <Badge tone="warning">No employees yet</Badge>;
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <select
        value={selected}
        disabled={pending}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Assign this device to an employee"
        className="w-full min-w-40 rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-brand disabled:opacity-50"
      >
        <option value="" disabled>
          {pending ? 'Assigning...' : 'Unassigned - pick an employee'}
        </option>
        {employees.map((employee) => (
          <option key={employee.id} value={employee.id}>
            {employee.name}
            {employee.department ? ` - ${employee.department}` : ''}
          </option>
        ))}
      </select>
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </div>
  );
}
