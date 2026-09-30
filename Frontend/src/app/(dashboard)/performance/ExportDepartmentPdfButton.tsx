"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button, useToast } from "@/components/ui";

export function ExportDepartmentPdfButton({
  departmentId,
  departmentName,
  startDate,
  endDate,
}: {
  departmentId: string;
  departmentName: string;
  startDate: string;
  endDate: string;
}) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);

    try {
      const params = new URLSearchParams({ startDate, endDate });
      const url = `/api/reports/departments/${encodeURIComponent(departmentId)}/pdf?${params}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download report (${response.status})`);
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      const safeName = departmentName.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
      link.download = `department_performance_${safeName}_${startDate}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
      toast.success(`Performance PDF for ${departmentName} downloaded.`);
    } catch (error) {
      console.error("Department PDF download error:", error);
      toast.error("Could not download the department PDF report. Please try again.", "Download Error");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={handleDownload}
      disabled={downloading}
      className="inline-flex items-center gap-1.5"
      title="Download department performance PDF"
    >
      {downloading ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <Download className="size-3.5" aria-hidden />
      )}
      <span>{downloading ? "Generating..." : "Export PDF"}</span>
    </Button>
  );
}
