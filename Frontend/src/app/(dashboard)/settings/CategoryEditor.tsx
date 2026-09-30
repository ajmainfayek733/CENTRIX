"use client";

import { useState, useTransition } from "react";
import {
  Card,
  TableWrap,
  TABLE_CLASS,
  Th,
  Td,
  TagBadge,
  Badge,
  Button,
  EmptyState,
} from "@/components/ui";
import type { CategoryRow, CategoryTarget, ProductivityTag, DepartmentSummary } from "@/types/api";
import { deleteCategory, upsertCategory } from "./actions";

const TAGS: ProductivityTag[] = ["Productive", "Neutral", "Unproductive", "Blacklisted"];

const ADD_RULE_CLASS =
  "border border-brand-strong bg-brand-strong text-brand-contrast shadow-none hover:bg-brand hover:text-brand-contrast";

export function CategoryEditor({
  organizationId,
  categories,
  departments = [],
}: {
  organizationId: string;
  categories: CategoryRow[];
  departments?: DepartmentSummary[];
}) {
  const [pattern, setPattern] = useState("");
  const [target, setTarget] = useState<CategoryTarget>("Domain");
  const [tag, setTag] = useState<ProductivityTag>("Unproductive");
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<string>("");
  const [filterDepartmentId, setFilterDepartmentId] = useState<string>("all");
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
          isBlacklisted: tag === "Blacklisted",
          departmentId: selectedDepartmentId || null,
        });
        setPattern("");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Could not save the rule.");
      }
    });
  }

  function remove(id: string, departmentId?: string | null) {
    setError(null);
    startTransition(async () => {
      try {
        await deleteCategory(organizationId, id, departmentId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Could not delete the rule.");
      }
    });
  }

  const filteredCategories = categories.filter((c) => {
    if (filterDepartmentId === "all") return true;
    if (filterDepartmentId === "org") return !c.departmentId;
    return c.departmentId === filterDepartmentId;
  });

  const inputClass =
    "rounded-md border border-border-strong bg-surface-strong px-3 py-1.5 text-[13.5px] text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-brand";

  return (
    <Card title={`Productivity rules - ${categories.length}`}>
      <div className="mb-5 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-medium text-text-secondary">Scope</span>
          <select
            value={selectedDepartmentId}
            onChange={(e) => setSelectedDepartmentId(e.target.value)}
            className={inputClass}
          >
            <option value="">Org-Wide (All)</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                Dept: {d.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-medium text-text-secondary">
            Matches
          </span>
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
          <span className="mb-1.5 block text-[12.5px] font-medium text-text-secondary">
            {target === "Domain" ? "Domain (suffix match)" : "App or process name (contains)"}
          </span>
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder={target === "Domain" ? "facebook.com" : "steam"}
            className={`${inputClass} w-full`}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-medium text-text-secondary">Tag as</span>
          <select
            value={tag}
            onChange={(e) => setRuleTagWrapper(e.target.value as ProductivityTag)}
            className={inputClass}
          >
            {TAGS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <Button
          type="button"
          variant="ghost"
          className={ADD_RULE_CLASS}
          onClick={add}
          disabled={pending || pattern.trim().length === 0}
        >
          Add rule
        </Button>
      </div>

      {error && <p className="mb-3 text-xs text-danger">{error}</p>}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] leading-relaxed text-text-secondary">
          Domains match by suffix, so <span className="font-mono">facebook.com</span> also covers{" "}
          <span className="font-mono">m.facebook.com</span>. Department rules override org-wide
          defaults for that team.
        </p>

        {departments.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-text-tertiary">Filter:</span>
            <select
              value={filterDepartmentId}
              onChange={(e) => setFilterDepartmentId(e.target.value)}
              className="rounded border border-border bg-surface px-2 py-1 text-xs text-text-secondary"
            >
              <option value="all">All Rules ({categories.length})</option>
              <option value="org">Org-Wide Only</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  Dept: {d.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {filteredCategories.length === 0 ? (
        <EmptyState message="No rules match the current filter." />
      ) : (
        <TableWrap>
          <table className={`${TABLE_CLASS} min-w-[560px]`}>
            <thead>
              <tr>
                <Th>Pattern</Th>
                <Th>Type</Th>
                <Th>Scope</Th>
                <Th>Tag</Th>
                <Th align="right">Remove</Th>
              </tr>
            </thead>
            <tbody>
              {filteredCategories.map((rule) => {
                const dept = departments.find((d) => d.id === rule.departmentId);
                return (
                  <tr
                    key={rule.id ?? `${rule.target}-${rule.pattern}-${rule.departmentId || "org"}`}
                  >
                    <Td>
                      <span className="font-mono text-xs">{rule.pattern}</span>
                    </Td>
                    <Td muted>{rule.target === "Domain" ? "Website" : "Application"}</Td>
                    <Td>
                      {dept ? (
                        <Badge tone="brand">Dept: {dept.name}</Badge>
                      ) : (
                        <Badge tone="neutral">Org-Wide</Badge>
                      )}
                    </Td>
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
                        onClick={() => remove(rule.id, rule.departmentId)}
                        disabled={pending || !rule.id}
                        className="rounded-md border border-border-strong px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );

  function setRuleTagWrapper(t: ProductivityTag) {
    setTag(t);
  }
}
