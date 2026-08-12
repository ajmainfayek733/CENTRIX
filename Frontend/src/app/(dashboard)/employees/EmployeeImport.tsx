'use client';

import { useState, useTransition } from 'react';
import { Card, Badge } from '@/components/ui';
import { importEmployees, type ImportResult, type ImportRow } from './actions';

/** Rows past this are rejected by the server anyway; catching it here gives a better message. */
const MAX_ROWS = 1000;

/**
 * Bulk roster import.
 *
 * Paste-a-CSV rather than a file picker: the source is almost always a column selection from a
 * spreadsheet or an AD export, and pasting skips the save-as-CSV step entirely. The parser is
 * intentionally forgiving - a header row, tabs from Excel, and quoted fields all work - because
 * the failure mode of a strict parser here is an admin editing a hundred-line file by hand.
 */
export function EmployeeImport({ organizationId }: { organizationId: string }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const parsed = parseRoster(text);

  function submit() {
    if (parsed.rows.length === 0) return;

    setError(null);
    setResult(null);

    startTransition(async () => {
      try {
        const summary = await importEmployees(organizationId, parsed.rows);
        setResult(summary);
        if (summary.created > 0) setText('');
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : 'Import failed.');
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-brand-contrast transition-opacity hover:opacity-90"
      >
        Import roster
      </button>
    );
  }

  return (
    <Card title="Import roster">
      <p className="mb-3 text-sm text-text-secondary">
        Paste one employee per line as <span className="font-mono text-xs">name, email, department</span>.
        Department is optional, a header row is ignored, and tab-separated text pasted straight
        from a spreadsheet works. Re-importing a file that already contains existing people is
        safe - those rows are skipped, not duplicated.
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        spellCheck={false}
        placeholder={'Ada Lovelace, ada@example.com, Engineering\nGrace Hopper, grace@example.com, Engineering'}
        className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs outline-none focus:border-brand"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={pending || parsed.rows.length === 0 || parsed.rows.length > MAX_ROWS}
          className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-brand-contrast transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Importing...' : `Import ${parsed.rows.length || ''} employee${parsed.rows.length === 1 ? '' : 's'}`}
        </button>

        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setResult(null);
            setError(null);
          }}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-brand hover:text-brand"
        >
          Close
        </button>

        {parsed.rows.length > MAX_ROWS && (
          <span className="text-xs text-danger">
            {parsed.rows.length} rows - split the file, {MAX_ROWS} is the per-request maximum.
          </span>
        )}

        {parsed.invalid.length > 0 && (
          <span className="text-xs text-warning">
            {parsed.invalid.length} line{parsed.invalid.length === 1 ? '' : 's'} skipped as unparseable
          </span>
        )}
      </div>

      {parsed.invalid.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-[11px] text-text-secondary">
          {parsed.invalid.slice(0, 5).map((line, i) => (
            <li key={i} className="font-mono">
              {line}
            </li>
          ))}
          {parsed.invalid.length > 5 && <li>...and {parsed.invalid.length - 5} more</li>}
        </ul>
      )}

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}

      {result && (
        <div className="mt-4 rounded-lg border border-border bg-surface-muted px-4 py-3">
          <p className="text-sm">
            <Badge tone="brand">{result.created} created</Badge>{' '}
            {result.skipped > 0 && <Badge tone="warning">{result.skipped} skipped</Badge>}
          </p>

          {result.skipped > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-text-secondary">
              {result.results
                .filter((r) => r.status === 'skipped')
                .slice(0, 10)
                .map((r) => (
                  <li key={r.email}>
                    <span className="font-mono">{r.email}</span> - {r.reason}
                  </li>
                ))}
              {result.skipped > 10 && <li>...and {result.skipped - 10} more</li>}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Splits pasted text into rows.
 *
 * Accepts comma or tab separators, tolerates quoted fields containing commas, and drops a
 * header line. Anything without a plausible email is reported back rather than silently
 * dropped - a mistyped address should be visible, not vanish.
 */
function parseRoster(text: string): { rows: ImportRow[]; invalid: string[] } {
  const rows: ImportRow[] = [];
  const invalid: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const fields = splitFields(line);
    const [name, email, department] = fields;

    // Header row: no email-shaped field anywhere and the second column reads like a label.
    if (!email && !name?.includes('@')) {
      invalid.push(line);
      continue;
    }

    const emailField = email?.includes('@') ? email : fields.find((f) => f.includes('@'));
    if (!emailField || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailField)) {
      // Skip a header line quietly rather than reporting it as an error.
      if (/^(name|full ?name|employee)\b/i.test(line)) continue;
      invalid.push(line);
      continue;
    }

    const resolvedName = name && !name.includes('@') ? name : emailField.split('@')[0];
    if (resolvedName.trim().length < 2) {
      invalid.push(line);
      continue;
    }

    rows.push({
      name: resolvedName.trim(),
      email: emailField.trim(),
      ...(department?.trim() ? { department: department.trim() } : {}),
    });
  }

  return { rows, invalid };
}

/** Minimal CSV/TSV field splitter with double-quote support. */
function splitFields(line: string): string[] {
  const separator = line.includes('\t') ? '\t' : ',';
  const fields: string[] = [];

  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      // A doubled quote inside a quoted field is a literal quote.
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === separator && !quoted) {
      fields.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current.trim());
  return fields;
}
