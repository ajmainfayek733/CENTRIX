"use client";

import { useState, useTransition } from "react";
import {
  Plus,
  Trash2,
  UserPlus,
  UserMinus,
  Layers,
  X,
  Loader2,
  Info,
  AlertCircle,
} from "lucide-react";
import {
  Card,
  Button,
  Badge,
  TableWrap,
  TABLE_CLASS,
  Th,
  Td,
  EmptyState,
  TagBadge,
} from "@/components/ui";
import type {
  DepartmentSummary,
  RosterEmployee,
  CategoryTarget,
  ProductivityTag,
} from "@/types/api";
import {
  createDepartment,
  deleteDepartment,
  addDepartmentMembers,
  removeDepartmentMember,
  upsertDepartmentCategory,
  deleteDepartmentCategory,
} from "./actions";

const SAVE_PRIMARY_CLASS =
  "border border-brand-strong bg-brand-strong text-brand-contrast shadow-none hover:bg-brand hover:text-brand-contrast";

const TAGS: ProductivityTag[] = ["Productive", "Neutral", "Unproductive", "Blacklisted"];

interface DepartmentManagerProps {
  organizationId: string;
  departments: DepartmentSummary[];
  allEmployees: RosterEmployee[];
  userRole?: string;
}

export function DepartmentManager({
  organizationId,
  departments,
  allEmployees,
  userRole,
}: DepartmentManagerProps) {
  const [activeDeptId, setActiveDeptId] = useState<string | null>(departments[0]?.id || null);

  // New Department Form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newDeptName, setNewDeptName] = useState("");
  const [newDeptDescription, setNewDeptDescription] = useState("");

  // New Rule Form for Active Department
  const [rulePattern, setRulePattern] = useState("");
  const [ruleTarget, setRuleTarget] = useState<CategoryTarget>("Domain");
  const [ruleTag, setRuleTag] = useState<ProductivityTag>("Productive");

  // Selected employees to add
  const [selectedEmpIds, setSelectedEmpIds] = useState<string[]>([]);

  // Transition & status
  const [pending, startTransition] = useTransition();
  const [statusMessage, setStatusMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const isAdmin = userRole === "super_admin";

  // 1. Create Department Handler
  function handleCreateDepartment(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = newDeptName.trim();
    if (!trimmedName) {
      setStatusMessage({
        type: "error",
        text: "Please enter a department name (e.g., Marketing, Engineering).",
      });
      return;
    }

    setStatusMessage(null);
    startTransition(async () => {
      try {
        await createDepartment(organizationId, {
          name: trimmedName,
          description: newDeptDescription.trim() || undefined,
        });
        setNewDeptName("");
        setNewDeptDescription("");
        setShowCreateForm(false);
        setStatusMessage({
          type: "success",
          text: `Department "${trimmedName}" created successfully.`,
        });
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : "";
        let friendly = "Could not create the department. Please verify the name and try again.";
        if (raw.includes("already exists")) {
          friendly = `A department named "${trimmedName}" already exists in your organization. Please use a distinct name.`;
        } else if (
          raw &&
          !raw.includes("Cannot") &&
          !raw.includes("<") &&
          !raw.includes("Endpoint")
        ) {
          friendly = raw;
        }
        setStatusMessage({
          type: "error",
          text: friendly,
        });
      }
    });
  }

  // 2. Delete Department Handler
  function handleDeleteDepartment(deptId: string, deptName: string) {
    if (
      !confirm(`Are you sure you want to delete "${deptName}"? Members will be safely unassigned.`)
    ) {
      return;
    }

    setStatusMessage(null);
    startTransition(async () => {
      try {
        await deleteDepartment(organizationId, deptId);
        if (activeDeptId === deptId) {
          setActiveDeptId(null);
        }
        setStatusMessage({ type: "success", text: `Department "${deptName}" deleted.` });
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : "";
        let friendly = "Could not delete this department. Please refresh the page and try again.";
        if (raw.includes("not found")) {
          friendly = "This department was already removed or does not exist.";
        } else if (
          raw &&
          !raw.includes("Cannot") &&
          !raw.includes("<") &&
          !raw.includes("Endpoint")
        ) {
          friendly = raw;
        }
        setStatusMessage({
          type: "error",
          text: friendly,
        });
      }
    });
  }

  // 3. Add Members Handler
  function handleAddMembers(deptId: string) {
    if (selectedEmpIds.length === 0) return;

    setStatusMessage(null);
    startTransition(async () => {
      try {
        await addDepartmentMembers(organizationId, deptId, selectedEmpIds);
        setSelectedEmpIds([]);
        setStatusMessage({
          type: "success",
          text: `Assigned ${selectedEmpIds.length} employee(s) to department.`,
        });
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : "";
        let friendly =
          "Could not assign employees to this department. Please refresh and try again.";
        if (raw.includes("No matching employees")) {
          friendly =
            "The selected employees were not found in this organization. Please refresh the page.";
        } else if (
          raw &&
          !raw.includes("Cannot") &&
          !raw.includes("<") &&
          !raw.includes("Endpoint")
        ) {
          friendly = raw;
        }
        setStatusMessage({
          type: "error",
          text: friendly,
        });
      }
    });
  }

  // 4. Remove Member Handler
  function handleRemoveMember(deptId: string, employeeId: string, empName: string) {
    setStatusMessage(null);
    startTransition(async () => {
      try {
        await removeDepartmentMember(organizationId, deptId, employeeId);
        setStatusMessage({ type: "success", text: `Removed ${empName} from department.` });
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : "";
        let friendly = `Could not remove ${empName} from the department. Please try again.`;
        if (raw && !raw.includes("Cannot") && !raw.includes("<") && !raw.includes("Endpoint")) {
          friendly = raw;
        }
        setStatusMessage({
          type: "error",
          text: friendly,
        });
      }
    });
  }

  // 5. Add Department Rule Handler
  function handleAddRule(deptId: string) {
    const trimmedPattern = rulePattern.trim().toLowerCase();
    if (!trimmedPattern) {
      setStatusMessage({
        type: "error",
        text: "Please enter a domain (e.g. facebook.com) or application name before adding a rule.",
      });
      return;
    }

    setStatusMessage(null);
    startTransition(async () => {
      try {
        await upsertDepartmentCategory(organizationId, deptId, {
          pattern: trimmedPattern,
          target: ruleTarget,
          tag: ruleTag,
          isBlacklisted: ruleTag === "Blacklisted",
        });
        setRulePattern("");
        setStatusMessage({
          type: "success",
          text: `Saved department rule for "${trimmedPattern}" as ${ruleTag}.`,
        });
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : "";
        let friendly = `Unable to save rule for "${trimmedPattern}". Please check the domain/app format and try again.`;
        if (raw.includes("Department not found")) {
          friendly = "The department was not found. Please refresh the page.";
        } else if (
          raw.includes("permission") ||
          raw.includes("Unauthorized") ||
          raw.includes("Forbidden")
        ) {
          friendly = "You need administrator permissions to update department productivity rules.";
        } else if (
          raw &&
          !raw.includes("Cannot") &&
          !raw.includes("<") &&
          !raw.includes("Endpoint")
        ) {
          friendly = raw;
        }
        setStatusMessage({
          type: "error",
          text: friendly,
        });
      }
    });
  }

  // 6. Delete Department Rule Handler
  function handleDeleteRule(deptId: string, categoryId: string, pattern: string) {
    setStatusMessage(null);
    startTransition(async () => {
      try {
        await deleteDepartmentCategory(organizationId, deptId, categoryId);
        setStatusMessage({
          type: "success",
          text: `Deleted department rule for "${pattern}".`,
        });
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : "";
        let friendly = `Could not delete rule for "${pattern}". It may have already been removed.`;
        if (raw && !raw.includes("Cannot") && !raw.includes("<") && !raw.includes("Endpoint")) {
          friendly = raw;
        }
        setStatusMessage({
          type: "error",
          text: friendly,
        });
      }
    });
  }

  const selectedDept = departments.find((d) => d.id === activeDeptId);
  const deptMembers = allEmployees.filter(
    (e) =>
      e.department &&
      selectedDept &&
      e.department.toLowerCase() === selectedDept.name.toLowerCase(),
  );
  const availableEmployees = allEmployees.filter(
    (e) =>
      !e.department ||
      (selectedDept && e.department.toLowerCase() !== selectedDept.name.toLowerCase()),
  );

  const inputClass =
    "rounded-md border border-border-strong bg-surface-strong px-3 py-1.5 text-[13.5px] text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-brand";

  return (
    <div className="space-y-6">
      {/* Top Banner Status Notification */}
      {statusMessage && (
        <div
          className={`p-3.5 rounded-lg border text-sm flex items-start justify-between gap-3 ${
            statusMessage.type === "success"
              ? "bg-success/10 border-success/30 text-success"
              : "bg-danger/10 border-danger/30 text-danger"
          }`}
        >
          <div className="flex items-start gap-2.5">
            {statusMessage.type === "error" ? (
              <AlertCircle className="size-5 shrink-0 mt-0.5" />
            ) : null}
            <div>
              <p className="font-medium text-[13px]">
                {statusMessage.type === "success"
                  ? "Action Completed"
                  : "Notice for Organization Administrator"}
              </p>
              <p className="text-xs mt-0.5 opacity-90 leading-relaxed">{statusMessage.text}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setStatusMessage(null)}
            className="text-xs hover:underline opacity-80 shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Header Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Department Directory</h2>
          <p className="text-xs text-text-secondary">
            Organize employees by teams and configure department-scoped productivity lists with org
            fallback.
          </p>
        </div>

        {isAdmin && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowCreateForm(!showCreateForm)}
            className={`inline-flex items-center gap-1.5 ${
              showCreateForm
                ? "border border-border bg-surface text-text-primary hover:bg-surface-strong"
                : SAVE_PRIMARY_CLASS
            }`}
          >
            {showCreateForm ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
            <span>{showCreateForm ? "Cancel" : "New Department"}</span>
          </Button>
        )}
      </div>

      {/* New Department Drawer / Box */}
      {showCreateForm && (
        <Card
          title="Create New Department"
          className="border-brand/40 shadow-glass-md animate-in fade-in duration-200"
        >
          <form onSubmit={handleCreateDepartment} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-text-secondary">
                  Department Name <span className="text-brand">*</span>
                </span>
                <input
                  value={newDeptName}
                  onChange={(e) => setNewDeptName(e.target.value)}
                  placeholder="e.g. Engineering, Sales, Human Resources"
                  required
                  className={`${inputClass} w-full`}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-text-secondary">
                  Description
                </span>
                <input
                  value={newDeptDescription}
                  onChange={(e) => setNewDeptDescription(e.target.value)}
                  placeholder="e.g. Core product software development team"
                  className={`${inputClass} w-full`}
                />
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowCreateForm(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={pending || !newDeptName.trim()}
                className={SAVE_PRIMARY_CLASS}
              >
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : "Save Department"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Departments Grid */}
      {departments.length === 0 ? (
        <Card>
          <EmptyState message="No departments exist yet. Create your first department above to assign employees and configure custom productivity rules." />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {departments.map((dept) => {
            const isSelected = dept.id === activeDeptId;
            const memberCount = allEmployees.filter(
              (e) => e.department && e.department.toLowerCase() === dept.name.toLowerCase(),
            ).length;

            return (
              <div
                key={dept.id}
                onClick={() => setActiveDeptId(dept.id)}
                className={`cursor-pointer rounded-lg border p-4.5 transition-all duration-200 ease-out hover:-translate-y-0.5 ${
                  isSelected
                    ? "border-brand bg-brand-soft/40 shadow-glass-md ring-1 ring-brand/30"
                    : "border-glass-border bg-surface hover:border-border-strong shadow-glass-sm"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[14.5px] font-semibold text-text-primary truncate">
                      {dept.name}
                    </p>
                    <p className="mt-0.5 text-[12px] text-text-secondary line-clamp-2">
                      {dept.description || "No description set"}
                    </p>
                  </div>
                  {isSelected && <Badge tone="brand">Active</Badge>}
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-glass-border pt-3">
                  <div>
                    <dd className="tnum text-base font-semibold text-text-primary">
                      {memberCount}
                    </dd>
                    <dt className="text-[11px] text-text-tertiary">Members</dt>
                  </div>
                  <div>
                    <dd className="tnum text-base font-semibold text-text-primary">
                      {dept._count?.categories ?? 0}
                    </dd>
                    <dt className="text-[11px] text-text-tertiary">Custom Rules</dt>
                  </div>
                </dl>
              </div>
            );
          })}
        </div>
      )}

      {/* Selected Department Manager Workspace */}
      {selectedDept && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* 1. Member Management Card */}
          <Card
            title={`${selectedDept.name} — Members (${deptMembers.length})`}
            action={
              isAdmin && (
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => handleDeleteDepartment(selectedDept.id, selectedDept.name)}
                  className="text-xs"
                  title="Delete this department"
                >
                  <Trash2 className="size-3.5" />
                  <span>Delete</span>
                </Button>
              )
            }
          >
            <div className="space-y-4">
              {/* Member Assign Input */}
              {isAdmin && availableEmployees.length > 0 && (
                <div className="bg-surface-muted/60 p-3 rounded-md border border-glass-border space-y-2">
                  <p className="text-[12px] font-medium text-text-secondary flex items-center gap-1.5">
                    <UserPlus className="size-3.5 text-brand" />
                    <span>Assign Employees to {selectedDept.name}</span>
                  </p>

                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value=""
                      onChange={(e) => {
                        const id = e.target.value;
                        if (id && !selectedEmpIds.includes(id)) {
                          setSelectedEmpIds([...selectedEmpIds, id]);
                        }
                      }}
                      className={`${inputClass} flex-1 text-xs`}
                    >
                      <option value="">Select an employee to add...</option>
                      {availableEmployees.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name} {e.department ? `(Currently: ${e.department})` : "(Unassigned)"}
                        </option>
                      ))}
                    </select>

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleAddMembers(selectedDept.id)}
                      disabled={pending || selectedEmpIds.length === 0}
                      className={`text-xs ${SAVE_PRIMARY_CLASS}`}
                    >
                      {pending ? <Loader2 className="size-3.5 animate-spin" /> : "Assign Selected"}
                    </Button>
                  </div>

                  {/* Selected badges before commit */}
                  {selectedEmpIds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {selectedEmpIds.map((id) => {
                        const emp = allEmployees.find((e) => e.id === id);
                        return (
                          <span
                            key={id}
                            className="inline-flex items-center gap-1 text-[11.5px] bg-brand-soft text-brand px-2 py-0.5 rounded-full"
                          >
                            {emp?.name}
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedEmpIds(selectedEmpIds.filter((x) => x !== id))
                              }
                              className="hover:text-danger"
                            >
                              &times;
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Members Table */}
              {deptMembers.length === 0 ? (
                <EmptyState
                  message={`No employees are currently assigned to ${selectedDept.name}. Use the selector above to assign members.`}
                />
              ) : (
                <TableWrap>
                  <table className={TABLE_CLASS}>
                    <thead>
                      <tr>
                        <Th>Employee</Th>
                        <Th>Email</Th>
                        <Th>Devices</Th>
                        {isAdmin && <Th align="right">Action</Th>}
                      </tr>
                    </thead>
                    <tbody>
                      {deptMembers.map((member) => (
                        <tr key={member.id}>
                          <Td>
                            <a
                              href={`/employees/${member.id}`}
                              className="font-medium text-text-primary hover:text-brand hover:underline"
                            >
                              {member.name}
                            </a>
                          </Td>
                          <Td muted>{member.email}</Td>
                          <Td numeric>{member.deviceCount}</Td>
                          {isAdmin && (
                            <Td align="right">
                              <button
                                type="button"
                                onClick={() =>
                                  handleRemoveMember(selectedDept.id, member.id, member.name)
                                }
                                className="text-text-tertiary hover:text-danger transition-colors p-1"
                                title="Remove from department"
                              >
                                <UserMinus className="size-3.5" />
                              </button>
                            </Td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </div>
          </Card>

          {/* 2. Department Productivity Rules Card */}
          <Card
            title={`${selectedDept.name} — Productivity Rules`}
            action={
              <Badge tone="brand">{selectedDept._count?.categories ?? 0} active rule(s)</Badge>
            }
          >
            <div className="space-y-4">
              {/* Meaningful Admin Note */}
              <div className="rounded-md border border-brand/20 bg-brand-soft/30 p-3 text-[12px] text-text-secondary flex gap-2.5">
                <Info className="size-4 text-brand shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-medium text-text-primary">
                    Department Rules Override Org-Wide Rules
                  </p>
                  <p className="text-[11.5px] leading-relaxed">
                    Rules configured here take precedence over organization-wide settings for all
                    members of <strong>{selectedDept.name}</strong>. For example, if{" "}
                    <code className="bg-surface-strong px-1 py-0.5 rounded text-[11px]">
                      facebook.com
                    </code>{" "}
                    is marked <em>Unproductive</em> or <em>Blacklisted</em> org-wide, adding it as{" "}
                    <em>Productive</em> here allows this department&apos;s team members to browse
                    Facebook productively while preserving the default classification for everyone
                    else in the organization.
                  </p>
                </div>
              </div>

              {/* Add Rule Form */}
              {isAdmin && (
                <div className="bg-surface-muted/60 p-3 rounded-md border border-glass-border space-y-2">
                  <p className="text-[12px] font-medium text-text-secondary">
                    Add Department-Specific Rule
                  </p>

                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={ruleTarget}
                      onChange={(e) => setRuleTarget(e.target.value as CategoryTarget)}
                      className={`${inputClass} text-xs`}
                    >
                      <option value="Domain">Domain</option>
                      <option value="Application">Application</option>
                    </select>

                    <input
                      value={rulePattern}
                      onChange={(e) => setRulePattern(e.target.value)}
                      placeholder={ruleTarget === "Domain" ? "e.g. facebook.com" : "e.g. figma"}
                      className={`${inputClass} flex-1 text-xs`}
                    />

                    <select
                      value={ruleTag}
                      onChange={(e) => setRuleTag(e.target.value as ProductivityTag)}
                      className={`${inputClass} text-xs`}
                    >
                      {TAGS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleAddRule(selectedDept.id)}
                      disabled={pending || !rulePattern.trim()}
                      className={`text-xs ${SAVE_PRIMARY_CLASS}`}
                    >
                      {pending ? <Loader2 className="size-3.5 animate-spin" /> : "Add Rule"}
                    </Button>
                  </div>
                </div>
              )}

              {/* Department Rules Table */}
              {!selectedDept.categories || selectedDept.categories.length === 0 ? (
                <EmptyState
                  message={`No custom rules defined for ${selectedDept.name}. Members will follow organization-wide defaults.`}
                />
              ) : (
                <TableWrap>
                  <table className={TABLE_CLASS}>
                    <thead>
                      <tr>
                        <Th>Target</Th>
                        <Th>Pattern</Th>
                        <Th>Productivity</Th>
                        <Th>Status</Th>
                        {isAdmin && <Th align="right">Action</Th>}
                      </tr>
                    </thead>
                    <tbody>
                      {selectedDept.categories.map((cat) => (
                        <tr key={cat.id}>
                          <Td>
                            <Badge tone="neutral">{cat.target}</Badge>
                          </Td>
                          <Td>
                            <span className="font-mono text-xs font-medium text-text-primary">
                              {cat.pattern}
                            </span>
                          </Td>
                          <Td>
                            <TagBadge tag={cat.tag} />
                          </Td>
                          <Td>
                            {cat.isBlacklisted ? (
                              <Badge tone="danger">Blacklisted</Badge>
                            ) : (
                              <span className="text-xs text-text-tertiary">Allowed</span>
                            )}
                          </Td>
                          {isAdmin && (
                            <Td align="right">
                              <button
                                type="button"
                                onClick={() =>
                                  handleDeleteRule(selectedDept.id, cat.id, cat.pattern)
                                }
                                className="text-text-tertiary hover:text-danger transition-colors p-1"
                                title="Delete department rule"
                                disabled={pending}
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </Td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}

              <div className="text-[11.5px] text-text-tertiary flex items-center gap-2">
                <Layers className="size-3.5 text-brand" />
                <span>
                  Resolution Hierarchy: Department Blacklist &rarr; Org Blacklist &rarr; Department
                  Rule &rarr; Org Rule &rarr; Default
                </span>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
