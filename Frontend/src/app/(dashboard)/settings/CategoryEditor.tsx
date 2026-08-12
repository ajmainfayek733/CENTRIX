'use client';

import { useState, useTransition } from 'react';
import { Card, TableWrap, Th, Td, TagBadge, Badge, EmptyState } from '@/components/ui';
import type { CategoryRow, CategoryTarget, ProductivityTag } from '@/types/api';
import { deleteCategory, upsertCategory } from './actions';

const TAGS: ProductivityTag[] = ['Productive', 'Neutral', 'Unproductive', 'Blacklisted'];

/**
 * Productivity and blacklist rules (spec section 4, "Productivity categorization").
 *
 * These serve double duty: the backend re-tags every ingested activity and browser row against
 * them, and the agent receives them with its policy so it can raise a blacklist notification on
 * the desktop without a round trip.
 */
export function CategoryEditor({
  organizationId,
  categories,
}: {
  organizationId: string;
  categories: CategoryRow[];
}) {
  const [pattern, setPattern] = useState('');
  const [target, setTarget] = useState<CategoryTarget>('Domain');
  const [tag, setTag] = useState<ProductivityTag>('Unproductive');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function add() {
    const trimmed = pattern.trim().toLowerCase();
    if (!trimmed) return;

    setError(null);
    startTransition(async () => {
      try {
        await upsertCategory(organizationId, {
          pattern: trimmed,
          target,
          tag,
          // "Blacklisted" is not just a label â€” it is what makes the agent warn the employee,
          // so selecting it here sets the flag the alert engine actually reads.
          isBlacklisted: tag === 'Blacklisted',
        });
        setPattern('');
      } catch {
        setError('Could not save the rule.');
      }
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        await deleteCategory(organizationId, id);
      } catch {
        setError('Could not delete the rule.');
      }
    });
  }

  const inputClass =
    'rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand';

  return (
    <Card title={`Productivity rules Â· ${categories.length}`}>
      <div className="mb-5 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-text-secondary">Matches</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as CategoryTarget)}
            className={inputClass}
          >
            <option value="Domain">Website domain</option>
            <option value="Application">Application</option>
          </select>
        </label>

        <label className="block flex-1 min-w-48">
          <span className="mb-1 block text-xs text-text-secondary">
            {target === 'Domain' ? 'Domain (suffix match)' : 'App or process name (contains)'}
          </span>
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
            placeholder={target === 'Domain' ? 'facebook.com' : 'steam'}
            className={`${inputClass} w-full`}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-text-secondary">Tag as</span>
          <select
            value={tag}
            onChange={(e) => setTag(e.target.value as ProductivityTag)}
            className={inputClass}
          >
            {TAGS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={add}
          disabled={pending || pattern.trim().length === 0}
          className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-brand-contrast transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Add rule
        </button>
      </div>

      {error && <p className="mb-3 text-xs text-danger">{error}</p>}

      <p className="mb-4 text-xs text-text-secondary">
        Domains match by suffix, so <span className="font-mono">facebook.com</span> also covers{' '}
        <span className="font-mono">m.facebook.com</span>. Applications match if the name,
        process or executable path contains the pattern.
      </p>

      {categories.length === 0 ? (
        <EmptyState message="No rules yet. Without them everything is tagged Neutral." />
      ) : (
        <TableWrap>
          <table className="w-full min-w-[520px] border-collapse">
            <thead>
              <tr>
                <Th>Pattern</Th>
                <Th>Type</Th>
                <Th>Tag</Th>
                <Th align="right">Remove</Th>
              </tr>
            </thead>
            <tbody>
              {categories.map((rule) => (
                <tr key={rule.id ?? `${rule.target}-${rule.pattern}`}>
                  <Td>
                    <span className="font-mono text-xs">{rule.pattern}</span>
                  </Td>
                  <Td muted>{rule.target === 'Domain' ? 'Website' : 'Application'}</Td>
                  <Td>
                    <TagBadge tag={rule.tag} />
                    {rule.isBlacklisted && (
                      <span className="ml-1.5">
                        <Badge tone="danger">warns employee</Badge>
                      </span>
                    )}
                  </Td>
                  <Td align="right">
                    <button
                      type="button"
                      onClick={() => remove(rule.id)}
                      disabled={pending || !rule.id}
                      className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}
