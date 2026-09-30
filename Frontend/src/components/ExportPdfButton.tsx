"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button, useToast } from "@/components/ui";
import { isoDate } from "@/lib/format";

interface ExportPdfButtonProps {
  employeeId: string;
  employeeName?: string;
  startDate?: string;
  endDate?: string;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  className?: string;
  label?: string;
}

export function ExportPdfButton({
  employeeId,
  employeeName,
  startDate,
  endDate,
  variant = "secondary",
  size = "sm",
  className = "",
  label = "Export PDF",
}: ExportPdfButtonProps) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);

    try {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);

      const url = `/api/reports/employees/${encodeURIComponent(employeeId)}/pdf?${params.toString()}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download report (${response.status})`);
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;

      const datePart = startDate || isoDate(new Date());
      const safeName = (employeeName || employeeId).replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
      link.download = `report_${safeName}_${datePart}.pdf`;

      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
      toast.success(`PDF report downloaded for ${employeeName || "employee"}.`);
    } catch (err) {
      console.error("PDF download error:", err);
      toast.error("Could not download the PDF report. Please try again.", "Download Error");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={handleDownload}
      disabled={downloading}
      className={`inline-flex items-center gap-1.5 ${className}`}
      title="Download comprehensive activity and attendance PDF report"
    >
      {downloading ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <Download className="size-3.5" aria-hidden />
      )}
      <span>{downloading ? "Generating..." : label}</span>
    </Button>
  );
}
