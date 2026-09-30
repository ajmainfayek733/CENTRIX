'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Plus, UserPlus, X } from 'lucide-react';
import { Badge, Button, Card, IconButton, Input, Notice, INPUT_CLASS } from '@/components/ui';
import { importEmployees, type ImportResult, type ImportRow } from './actions';
import { MAX_ROSTER_ROWS, ROSTER_PRIMARY_CLASS, ROSTER_SECONDARY_CLASS } from './rosterStyles';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_NAME_LENGTH = 2;
const NO_DEPARTMENT = '';

export interface DepartmentOption {
  id: string;
  name: string;
}

interface FormRow {
  key: number;
  name: string;
  email: string;
  departmentId: string;
}

type RowErrors = Record<number, string>;

const isBlank = (row: FormRow) => row.name.trim() === '' && row.email.trim() === '';

/** Keys only identify rows across re-renders; they never reach the DOM, so a module counter is safe. */
let rowKeyCounter = 0;
const newRow = (): FormRow => ({ key: rowKeyCounter++, name: '', email: '', departmentId: NO_DEPARTMENT });

function withoutKey(errors: RowErrors, key: number): RowErrors {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

/**
 * Add-employees form. One row per person; the plus button appends another row, and a single
 * submit inserts every filled row in one bulk request.
 *
 * Departments come from the backend and are optional. With none defined, the department control
 * is replaced by a hint and employees are created unassigned - the admin creates departments on
 * the Departments screen and assigns people there.
 */
export function EmployeeBulkForm({
  organizationId,
  departments,
}: {
  organizationId: string;
  departments: DepartmentOption[];
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<FormRow[]>(() => [newRow()]);
  const [rowErrors, setRowErrors] = useState<RowErrors>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const hasDepartments = departments.length > 0;
  const filledCount = rows.filter((row) => !isBlank(row)).length;

  function updateRow(key: number, patch: Partial<Omit<FormRow, 'key'>>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setRowErrors((current) => withoutKey(current, key));
  }

  function addRow() {
    setRows((current) => (current.length >= MAX_ROSTER_ROWS ? current : [...current, newRow()]));
  }

  function removeRow(key: number) {
    setRows((current) => (current.length <= 1 ? [newRow()] : current.filter((row) => row.key !== key)));
    setRowErrors((current) => withoutKey(current, key));
  }

  function close() {
    setOpen(false);
    setResult(null);
    setError(null);
    setRowErrors({});
  }

  /** Returns the payload, or null after flagging every problem row. */
  function validate(): ImportRow[] | null {
    const errors: RowErrors = {};
    const seen = new Set<string>();
    const payload: ImportRow[] = [];

    for (const row of rows) {
      if (isBlank(row)) continue;

      const name = row.name.trim();
      const email = row.email.trim();
      const normalized = email.toLowerCase();

      if (name.length < MIN_NAME_LENGTH) {
        errors[row.key] = `Name must be at least ${MIN_NAME_LENGTH} characters.`;
      } else if (!EMAIL_PATTERN.test(email)) {
        errors[row.key] = 'Enter a valid email address.';
      } else if (seen.has(normalized)) {
        errors[row.key] = 'This email is already in the form.';
      } else {
        seen.add(normalized);
        payload.push({
          name,
          email,
          ...(row.departmentId !== NO_DEPARTMENT ? { departmentId: row.departmentId } : {}),
        });
      }
    }

    setRowErrors(errors);
    return Object.keys(errors).length === 0 ? payload : null;
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    const payload = validate();
    if (!payload) return;
    if (payload.length === 0) {
      setError('Fill in at least one employee.');
      return;
    }

    startTransition(async () => {
      try {
        const summary = await importEmployees(organizationId, payload);
        setResult(summary);
        if (summary.created > 0) setRows([newRow()]);
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : 'Could not add employees.');
      }
    });
  }

  if (!open) {
    return (
      <Button type="button" variant="ghost" className={ROSTER_PRIMARY_CLASS} onClick={() => setOpen(true)}>
        <UserPlus className="size-4" strokeWidth={1.75} aria-hidden />
        Add employees
      </Button>
    );
  }

  return (
    <Card title="Add employees">
      <form onSubmit={submit} noValidate className="space-y-4">
        {!hasDepartments && (
          <Notice tone="warning">
            No departments exist yet, so these employees will be added without a department. Create
            departments on the{' '}
            <Link href="/departments" className="font-medium text-brand hover:underline">
              Departments
            </Link>{' '}
            page, then assign them there.
          </Notice>
        )}

        <ul className="space-y-3">
          {rows.map((row, index) => {
            const id = `employee-row-${index}`;
            const rowError = rowErrors[row.key];

            return (
              <li key={row.key}>
                <div className="grid items-center gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                  <Input
                    id={`${id}-name`}
                    aria-label={`Employee ${index + 1} name`}
                    aria-invalid={rowError ? true : undefined}
                    placeholder="Full name"
                    autoComplete="off"
                    value={row.name}
                    onChange={(e) => updateRow(row.key, { name: e.target.value })}
                  />
                  <Input
                    id={`${id}-email`}
                    type="email"
                    aria-label={`Employee ${index + 1} email`}
                    aria-invalid={rowError ? true : undefined}
                    placeholder="name@company.com"
                    autoComplete="off"
                    value={row.email}
                    onChange={(e) => updateRow(row.key, { email: e.target.value })}
                  />
                  <select
                    id={`${id}-department`}
                    aria-label={`Employee ${index + 1} department`}
                    className={INPUT_CLASS}
                    disabled={!hasDepartments}
                    value={row.departmentId}
                    onChange={(e) => updateRow(row.key, { departmentId: e.target.value })}
                  >
                    <option value={NO_DEPARTMENT}>No department</option>
                    {departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                  </select>
                  <IconButton
                    type="button"
                    aria-label={`Remove employee ${index + 1}`}
                    onClick={() => removeRow(row.key)}
                  >
                    <X className="size-4" strokeWidth={1.75} aria-hidden />
                  </IconButton>
                </div>
                {rowError && (
                  <p role="alert" className="mt-1 text-xs text-danger">
                    {rowError}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap items-center gap-3">
          <IconButton
            type="button"
            aria-label="Add another employee"
            title="Add another employee"
            onClick={addRow}
            disabled={rows.length >= MAX_ROSTER_ROWS}
          >
            <Plus className="size-4" strokeWidth={1.75} aria-hidden />
          </IconButton>

          <Button type="submit" variant="ghost" className={ROSTER_PRIMARY_CLASS} disabled={pending || filledCount === 0}>
            {pending ? 'Adding...' : `Add ${filledCount || ''} employee${filledCount === 1 ? '' : 's'}`}
          </Button>

          <Button type="button" variant="ghost" className={ROSTER_SECONDARY_CLASS} onClick={close}>
            Close
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        {result && (
          <div className="rounded-md border border-border-strong bg-surface-muted px-4 py-3">
            <p className="text-sm">
              <Badge tone="success">{result.created} created</Badge>{' '}
              {result.skipped > 0 && <Badge tone="warning">{result.skipped} skipped</Badge>}{' '}
              {result.unassigned > 0 && <Badge tone="neutral">{result.unassigned} without department</Badge>}
            </p>

            {result.skipped > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-text-secondary">
                {result.results
                  .filter((r) => r.status === 'skipped')
                  .map((r) => (
                    <li key={r.email}>
                      <span className="font-mono">{r.email}</span> - {r.reason}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}
