"use client";

import { useState } from "react";
import {
  Users,
  CalendarDays,
  Monitor,
  Bell,
  ChartColumn,
  Building2,
  Download,
  Loader2,
  FileText,
  Archive,
} from "lucide-react";
import { Button, Card, Badge, useToast } from "@/components/ui";
import type { RosterEmployee, DepartmentSummary } from "@/types/api";

const SAVE_PRIMARY_CLASS =
  "border border-brand-strong bg-brand-strong text-brand-contrast shadow-none hover:bg-brand hover:text-brand-contrast";

interface ReportGeneratorProps {
  employees: RosterEmployee[];
  departments: DepartmentSummary[];
}

type ReportScope = "employee" | "department_pdf" | "department_zip";

function getInitialDates() {
  const now = Date.now();
  return {
    today: new Date(now).toISOString().slice(0, 10),
    sevenDaysAgo: new Date(now - 7 * 86400000).toISOString().slice(0, 10),
  };
}

export function ReportGenerator({ employees, departments }: ReportGeneratorProps) {
  const toast = useToast();

  // Mode selection
  const [reportScope, setReportScope] = useState<ReportScope>("employee");

  // Selected parameters
  const [selectedDeptId, setSelectedDeptId] = useState<string>(departments[0]?.id || "");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>(employees[0]?.id || "");
  const [startDate, setStartDate] = useState<string>(() => getInitialDates().sevenDaysAgo);
  const [endDate, setEndDate] = useState<string>(() => getInitialDates().today);
  const [selectedDepartmentFilter, setSelectedDepartmentFilter] = useState<string>("all");

  // Loading states
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [generatingDeptPdf, setGeneratingDeptPdf] = useState(false);
  const [generatingZip, setGeneratingZip] = useState(false);
  const [exportingRoster, setExportingRoster] = useState(false);
  const [exportingDept, setExportingDept] = useState(false);

  // Filtered employees for PDF selection
  const filteredEmployees = employees.filter((e) => {
    if (selectedDepartmentFilter === "all") return true;
    return e.department?.toLowerCase() === selectedDepartmentFilter.toLowerCase();
  });

  // Keep selected employee valid when department filter changes
  const activeEmployeeId = filteredEmployees.some((e) => e.id === selectedEmployeeId)
    ? selectedEmployeeId
    : filteredEmployees[0]?.id || "";

  const selectedEmployee = employees.find((e) => e.id === activeEmployeeId);
  const selectedDepartment = departments.find((d) => d.id === selectedDeptId) || departments[0];

  // Preset date ranges
  function applyPreset(days: number) {
    const now = Date.now();
    const end = new Date(now).toISOString().slice(0, 10);
    const start = new Date(now - days * 86400000).toISOString().slice(0, 10);
    setStartDate(start);
    setEndDate(end);
  }

  // 1. Download Employee PDF Report
  async function downloadEmployeePdf(targetEmpId?: string) {
    const empId = targetEmpId || activeEmployeeId;
    if (!empId || generatingPdf) return;
    setGeneratingPdf(true);

    try {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);

      const url = `/api/reports/employees/${encodeURIComponent(empId)}/pdf?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to download report (${response.status})`);
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;

      const currentEmp = employees.find((e) => e.id === empId);
      const dateTag = new Date().toISOString().slice(0, 10);
      const safeName = (currentEmp?.name || empId).replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
      link.download = `employee_report_${safeName}_${startDate || dateTag}.pdf`;

      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
      toast.success(`PDF report for ${currentEmp?.name || "employee"} downloaded successfully.`);
    } catch (err) {
      console.error("PDF download error:", err);
      toast.error(
        "Could not generate the employee PDF report. Please verify parameters and try again.",
        "Download Error",
      );
    } finally {
      setGeneratingPdf(false);
    }
  }

  // 2. Download Department Performance PDF Report
  async function downloadDepartmentPdf(targetDeptId?: string) {
    const deptId = targetDeptId || selectedDepartment?.id;
    if (!deptId || generatingDeptPdf) return;
    setGeneratingDeptPdf(true);

    try {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);

      const url = `/api/reports/departments/${encodeURIComponent(deptId)}/pdf?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to download department report (${response.status})`);
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;

      const currentDept = departments.find((d) => d.id === deptId);
      const safeDeptName = (currentDept?.name || deptId).replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
      link.download = `department_performance_${safeDeptName}_${startDate || "overview"}.pdf`;

      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
      toast.success(`Performance PDF for ${currentDept?.name || "department"} downloaded.`);
    } catch (err) {
      console.error("Department PDF download error:", err);
      toast.error(
        "Could not generate the department PDF report. Please verify parameters and try again.",
        "Download Error",
      );
    } finally {
      setGeneratingDeptPdf(false);
    }
  }

  // 3. Download Department Batch ZIP Bundle
  async function downloadDepartmentZip(targetDeptId?: string) {
    const deptId = targetDeptId || selectedDepartment?.id;
    if (!deptId || generatingZip) return;
    setGeneratingZip(true);

    try {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);

      const url = `/api/reports/departments/${encodeURIComponent(deptId)}/batch-zip?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to download department bundle (${response.status})`);
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;

      const currentDept = departments.find((d) => d.id === deptId);
      const safeDeptName = (currentDept?.name || deptId).replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
      link.download = `department_bundle_${safeDeptName}_${startDate || "all"}.zip`;

      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
      toast.success(`Batch ZIP bundle for ${currentDept?.name || "department"} downloaded.`);
    } catch (err) {
      console.error("Department ZIP download error:", err);
      toast.error(
        "Could not generate the department ZIP bundle. Please verify parameters and try again.",
        "Download Error",
      );
    } finally {
      setGeneratingZip(false);
    }
  }

  // Primary Action Trigger based on Report Scope
  function handleMainAction() {
    if (reportScope === "employee") {
      downloadEmployeePdf();
    } else if (reportScope === "department_pdf") {
      downloadDepartmentPdf();
    } else {
      downloadDepartmentZip();
    }
  }

  const isMainLoading =
    (reportScope === "employee" && generatingPdf) ||
    (reportScope === "department_pdf" && generatingDeptPdf) ||
    (reportScope === "department_zip" && generatingZip);

  // 4. Export Team Roster (CSV)
  async function exportRosterCsv() {
    if (exportingRoster) return;
    setExportingRoster(true);

    try {
      const headers = [
        "Employee ID",
        "Name",
        "Email",
        "Department",
        "Status",
        "Devices",
        "Active Seconds",
        "Idle Seconds",
        "Productive Seconds",
        "Unproductive Seconds",
        "Neutral Seconds",
        "Blacklisted Seconds",
        "Productivity %",
      ];

      const rows = employees.map((e) => [
        `"${e.id}"`,
        `"${e.name.replace(/"/g, '""')}"`,
        `"${e.email.replace(/"/g, '""')}"`,
        `"${(e.department || "").replace(/"/g, '""')}"`,
        `"${e.status}"`,
        e.deviceCount,
        e.activeSeconds,
        e.idleSeconds,
        e.productiveSeconds,
        e.unproductiveSeconds,
        e.neutralSeconds,
        e.blacklistedSeconds,
        e.productivityPercent,
      ]);

      const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      const dateTag = new Date().toISOString().slice(0, 10);
      link.download = `roster_export_${dateTag}.csv`;

      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
      toast.success("Team roster exported successfully.");
    } catch (err) {
      console.error("CSV export error:", err);
      toast.error("Could not export team roster CSV.", "Export Failed");
    } finally {
      setExportingRoster(false);
    }
  }

  // 5. Export Department Summary (CSV)
  async function exportDepartmentCsv() {
    if (exportingDept) return;
    setExportingDept(true);

    try {
      const headers = [
        "Department ID",
        "Name",
        "Description",
        "Employees",
        "Productivity Rules",
        "Created At",
      ];

      const rows = departments.map((d) => [
        `"${d.id}"`,
        `"${d.name.replace(/"/g, '""')}"`,
        `"${(d.description || "").replace(/"/g, '""')}"`,
        d._count?.employees ?? 0,
        d._count?.categories ?? 0,
        `"${d.createdAt}"`,
      ]);

      const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      const dateTag = new Date().toISOString().slice(0, 10);
      link.download = `department_summary_${dateTag}.csv`;

      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
      toast.success("Department summary exported successfully.");
    } catch (err) {
      console.error("Department export error:", err);
      toast.error("Could not export department summary CSV.", "Export Failed");
    } finally {
      setExportingDept(false);
    }
  }

  const inputClass =
    "rounded-md border border-border-strong bg-surface-strong px-3 py-1.5 text-[13.5px] text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-brand";

  return (
    <div className="space-y-6">
      {/* Primary Interactive Report Builder Card */}
      <Card title="Executive Report Generator" className="border-brand/40 shadow-glass-md">
        <div className="space-y-4">
          <p className="text-[13px] text-text-secondary leading-relaxed">
            Generate and stream comprehensive executive reports in PDF format or batch ZIP bundles.
            Includes attendance logs, productivity breakdowns, application duration summaries,
            visited domains, and activity metrics.
          </p>

          {/* Scope Selector Tabs */}
          <div className="flex flex-wrap gap-2 border-b border-glass-border pb-3">
            <button
              type="button"
              onClick={() => setReportScope("employee")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                reportScope === "employee"
                  ? "bg-brand text-brand-contrast shadow-sm"
                  : "bg-surface text-text-secondary hover:bg-surface-strong hover:text-text-primary border border-border"
              }`}
            >
              <Users className="size-3.5" />
              <span>Individual Employee PDF</span>
            </button>

            <button
              type="button"
              onClick={() => setReportScope("department_pdf")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                reportScope === "department_pdf"
                  ? "bg-brand text-brand-contrast shadow-sm"
                  : "bg-surface text-text-secondary hover:bg-surface-strong hover:text-text-primary border border-border"
              }`}
            >
              <Building2 className="size-3.5" />
              <span>Whole Department Performance PDF</span>
            </button>

            <button
              type="button"
              onClick={() => setReportScope("department_zip")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                reportScope === "department_zip"
                  ? "bg-brand text-brand-contrast shadow-sm"
                  : "bg-surface text-text-secondary hover:bg-surface-strong hover:text-text-primary border border-border"
              }`}
            >
              <Archive className="size-3.5" />
              <span>Department Bundle ZIP (Summary + Members)</span>
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 items-end bg-surface-muted/50 p-4 rounded-lg border border-glass-border">
            {reportScope === "employee" ? (
              <>
                {/* Department Filter for Employee dropdown */}
                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1">
                    Filter by Department
                  </label>
                  <select
                    value={selectedDepartmentFilter}
                    onChange={(e) => setSelectedDepartmentFilter(e.target.value)}
                    className={`${inputClass} w-full`}
                  >
                    <option value="all">All Departments ({employees.length} total)</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.name}>
                        {d.name} (
                        {
                          employees.filter(
                            (e) => e.department?.toLowerCase() === d.name.toLowerCase(),
                          ).length
                        }
                        )
                      </option>
                    ))}
                  </select>
                </div>

                {/* Employee Selection */}
                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1">
                    Select Employee <span className="text-brand">*</span>
                  </label>
                  <select
                    value={activeEmployeeId}
                    onChange={(e) => setSelectedEmployeeId(e.target.value)}
                    className={`${inputClass} w-full font-medium`}
                  >
                    {filteredEmployees.length === 0 ? (
                      <option value="">No employees in department</option>
                    ) : (
                      filteredEmployees.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name} {e.department ? `(${e.department})` : ""}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              </>
            ) : (
              <>
                {/* Department Selection for Department PDF or ZIP */}
                <div className="sm:col-span-2">
                  <label className="block text-[12px] font-medium text-text-secondary mb-1">
                    Select Department <span className="text-brand">*</span>
                  </label>
                  <select
                    value={selectedDeptId}
                    onChange={(e) => setSelectedDeptId(e.target.value)}
                    className={`${inputClass} w-full font-medium`}
                  >
                    {departments.length === 0 ? (
                      <option value="">No departments available</option>
                    ) : (
                      departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} (
                          {
                            employees.filter(
                              (e) => e.department?.toLowerCase() === d.name.toLowerCase(),
                            ).length
                          }{" "}
                          members)
                        </option>
                      ))
                    )}
                  </select>
                </div>
              </>
            )}

            {/* Date Range Start */}
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={`${inputClass} w-full`}
              />
            </div>

            {/* Date Range End */}
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1">
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={`${inputClass} w-full`}
              />
            </div>
          </div>

          {/* Presets & Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <div className="flex items-center gap-1.5 text-[12px] text-text-tertiary">
              <span>Presets:</span>
              <button
                type="button"
                onClick={() => applyPreset(0)}
                className="px-2 py-0.5 rounded bg-surface hover:bg-surface-strong text-text-secondary hover:text-text-primary transition-colors border border-border"
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => applyPreset(7)}
                className="px-2 py-0.5 rounded bg-surface hover:bg-surface-strong text-text-secondary hover:text-text-primary transition-colors border border-border"
              >
                Last 7 Days
              </button>
              <button
                type="button"
                onClick={() => applyPreset(30)}
                className="px-2 py-0.5 rounded bg-surface hover:bg-surface-strong text-text-secondary hover:text-text-primary transition-colors border border-border"
              >
                Last 30 Days
              </button>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={handleMainAction}
              disabled={
                isMainLoading ||
                (reportScope === "employee" && !activeEmployeeId) ||
                (reportScope !== "employee" && departments.length === 0)
              }
              className={`inline-flex items-center gap-2 ${SAVE_PRIMARY_CLASS}`}
            >
              {isMainLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : reportScope === "department_zip" ? (
                <Archive className="size-4" aria-hidden />
              ) : (
                <Download className="size-4" aria-hidden />
              )}
              <span>
                {isMainLoading
                  ? "Compiling Report..."
                  : reportScope === "employee"
                    ? `Generate PDF (${selectedEmployee?.name || "Employee"})`
                    : reportScope === "department_pdf"
                      ? `Generate Department PDF (${selectedDepartment?.name || "Dept"})`
                      : `Download Bundle ZIP (${selectedDepartment?.name || "Dept"})`}
              </span>
            </Button>
          </div>
        </div>
      </Card>

      {/* Report Catalogue Grid */}
      <div>
        <h2 className="text-[14px] font-semibold text-text-primary mb-3">
          Available Export Formats & Reports
        </h2>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {/* 1. Employee Activity PDF */}
          <div className="flex flex-col rounded-lg border border-brand/40 bg-surface p-5 shadow-glass-sm transition-[transform,border-color] duration-200 ease-out hover:-translate-y-0.5">
            <div className="flex items-start justify-between gap-2 mb-3">
              <span className="grid size-[38px] place-items-center rounded-md bg-brand-soft text-brand">
                <Users className="size-[18px]" strokeWidth={1.75} />
              </span>
              <Badge tone="brand">Ready (PDF)</Badge>
            </div>

            <p className="text-sm font-semibold text-text-primary">
              Employee Activity & Productivity
            </p>
            <p className="mt-1.5 mb-4 flex-1 text-[12.5px] leading-relaxed text-text-secondary">
              Detailed attendance logs, daily active vs idle time, exact application duration,
              visited domains, and keyboard/mouse activity metrics.
            </p>

            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => downloadEmployeePdf()}
              disabled={!activeEmployeeId || generatingPdf}
              className={`self-start inline-flex items-center gap-1.5 ${SAVE_PRIMARY_CLASS}`}
            >
              {generatingPdf ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              <span>Download PDF ({selectedEmployee?.name || "Selected"})</span>
            </Button>
          </div>

          {/* 2. Department Performance PDF */}
          <div className="flex flex-col rounded-lg border border-brand/40 bg-surface p-5 shadow-glass-sm transition-[transform,border-color] duration-200 ease-out hover:-translate-y-0.5">
            <div className="flex items-start justify-between gap-2 mb-3">
              <span className="grid size-[38px] place-items-center rounded-md bg-brand-soft text-brand">
                <Building2 className="size-[18px]" strokeWidth={1.75} />
              </span>
              <Badge tone="brand">Ready (PDF)</Badge>
            </div>

            <p className="text-sm font-semibold text-text-primary">
              Department Performance Overview
            </p>
            <p className="mt-1.5 mb-4 flex-1 text-[12.5px] leading-relaxed text-text-secondary">
              Aggregated department KPIs, team productivity scores, member breakdown roster, top
              team applications, and visited web domains.
            </p>

            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => downloadDepartmentPdf()}
              disabled={generatingDeptPdf || departments.length === 0}
              className={`self-start inline-flex items-center gap-1.5 ${SAVE_PRIMARY_CLASS}`}
            >
              {generatingDeptPdf ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FileText className="size-3.5" />
              )}
              <span>Download PDF ({selectedDepartment?.name || "Department"})</span>
            </Button>
          </div>

          {/* 3. Department Batch ZIP Bundle */}
          <div className="flex flex-col rounded-lg border border-brand/40 bg-surface p-5 shadow-glass-sm transition-[transform,border-color] duration-200 ease-out hover:-translate-y-0.5">
            <div className="flex items-start justify-between gap-2 mb-3">
              <span className="grid size-[38px] place-items-center rounded-md bg-brand-soft text-brand">
                <Archive className="size-[18px]" strokeWidth={1.75} />
              </span>
              <Badge tone="brand">Ready (ZIP)</Badge>
            </div>

            <p className="text-sm font-semibold text-text-primary">Department Batch ZIP Bundle</p>
            <p className="mt-1.5 mb-4 flex-1 text-[12.5px] leading-relaxed text-text-secondary">
              Complete archive containing the department performance overview PDF plus individual
              PDF activity reports for every member in the department.
            </p>

            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => downloadDepartmentZip()}
              disabled={generatingZip || departments.length === 0}
              className={`self-start inline-flex items-center gap-1.5 ${SAVE_PRIMARY_CLASS}`}
            >
              {generatingZip ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Archive className="size-3.5" />
              )}
              <span>Download Bundle ZIP ({selectedDepartment?.name || "Department"})</span>
            </Button>
          </div>

          {/* 4. Employee Roster Summary */}
          <div className="flex flex-col rounded-lg border border-glass-border bg-surface p-5 shadow-glass-sm transition-[transform,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-border-strong">
            <div className="flex items-start justify-between gap-2 mb-3">
              <span className="grid size-[38px] place-items-center rounded-md bg-success/15 text-success">
                <CalendarDays className="size-[18px]" strokeWidth={1.75} />
              </span>
              <Badge tone="success">Ready (CSV)</Badge>
            </div>

            <p className="text-sm font-semibold text-text-primary">
              Team Roster & Productivity Mix
            </p>
            <p className="mt-1.5 mb-4 flex-1 text-[12.5px] leading-relaxed text-text-secondary">
              All employees across the organization with aggregate active time, idle time,
              productivity scores, and assigned devices.
            </p>

            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={exportRosterCsv}
              disabled={exportingRoster || employees.length === 0}
              className="self-start inline-flex items-center gap-1.5"
            >
              {exportingRoster ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              <span>Export Roster CSV</span>
            </Button>
          </div>

          {/* 5. Department Summary */}
          <div className="flex flex-col rounded-lg border border-glass-border bg-surface p-5 shadow-glass-sm transition-[transform,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-border-strong">
            <div className="flex items-start justify-between gap-2 mb-3">
              <span className="grid size-[38px] place-items-center rounded-md bg-brand-soft text-brand">
                <Building2 className="size-[18px]" strokeWidth={1.75} />
              </span>
              <Badge tone="brand">Ready (CSV)</Badge>
            </div>

            <p className="text-sm font-semibold text-text-primary">Department Structure & Rules</p>
            <p className="mt-1.5 mb-4 flex-1 text-[12.5px] leading-relaxed text-text-secondary">
              Department directory with member counts, active device counts, and assigned
              productivity rules.
            </p>

            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={exportDepartmentCsv}
              disabled={exportingDept || departments.length === 0}
              className="self-start inline-flex items-center gap-1.5"
            >
              {exportingDept ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              <span>Export Department CSV</span>
            </Button>
          </div>

          {/* 6. Device Inventory */}
          <div className="flex flex-col rounded-lg border border-glass-border bg-surface p-5 shadow-glass-sm opacity-80">
            <div className="flex items-start justify-between gap-2 mb-3">
              <span className="grid size-[38px] place-items-center rounded-md bg-surface-muted text-text-secondary">
                <Monitor className="size-[18px]" strokeWidth={1.75} />
              </span>
              <Badge tone="neutral">Via Devices</Badge>
            </div>

            <p className="text-sm font-semibold text-text-primary">Device Inventory & Versions</p>
            <p className="mt-1.5 mb-4 flex-1 text-[12.5px] leading-relaxed text-text-secondary">
              Machine GUIDs, Windows editions, MAC addresses, agent telemetry versions and
              heartbeats.
            </p>

            <a
              href="/devices"
              className="text-[12.5px] text-brand hover:underline font-medium inline-flex items-center gap-1"
            >
              View live devices page &rarr;
            </a>
          </div>

          {/* 7. Alerts & USB Security */}
          <div className="flex flex-col rounded-lg border border-glass-border bg-surface p-5 shadow-glass-sm opacity-80">
            <div className="flex items-start justify-between gap-2 mb-3">
              <span className="grid size-[38px] place-items-center rounded-md bg-surface-muted text-text-secondary">
                <Bell className="size-[18px]" strokeWidth={1.75} />
              </span>
              <Badge tone="neutral">Via Alerts</Badge>
            </div>

            <p className="text-sm font-semibold text-text-primary">Alerts & Security Incidents</p>
            <p className="mt-1.5 mb-4 flex-1 text-[12.5px] leading-relaxed text-text-secondary">
              Idle escalation triggers, blacklist access attempts, and removable drive insertion
              logs.
            </p>

            <a
              href="/alerts"
              className="text-[12.5px] text-brand hover:underline font-medium inline-flex items-center gap-1"
            >
              View live alerts feed &rarr;
            </a>
          </div>

          {/* 8. Organization Overview */}
          <div className="flex flex-col rounded-lg border border-glass-border bg-surface p-5 shadow-glass-sm opacity-80">
            <div className="flex items-start justify-between gap-2 mb-3">
              <span className="grid size-[38px] place-items-center rounded-md bg-surface-muted text-text-secondary">
                <ChartColumn className="size-[18px]" strokeWidth={1.75} />
              </span>
              <Badge tone="neutral">Via Overview</Badge>
            </div>

            <p className="text-sm font-semibold text-text-primary">
              Realtime Operational Dashboard
            </p>
            <p className="mt-1.5 mb-4 flex-1 text-[12.5px] leading-relaxed text-text-secondary">
              Aggregated daily hours, active presence, top applications and team productivity
              trends.
            </p>

            <a
              href="/overview"
              className="text-[12.5px] text-brand hover:underline font-medium inline-flex items-center gap-1"
            >
              View overview metrics &rarr;
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
