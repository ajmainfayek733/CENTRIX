import PDFDocument from "pdfkit";
import { formatDuration } from "../../lib/format";

export interface EmployeeReportData {
  employee: {
    id: string;
    name: string;
    email: string;
    department?: string | null;
    devices: Array<{
      id: string;
      deviceName: string;
      lastSeen?: Date | null;
      agentVersion?: string | null;
    }>;
  };
  period: {
    start: Date;
    end: Date;
  };
  totals: {
    activeSeconds: number;
    idleSeconds: number;
    productiveSeconds: number;
    unproductiveSeconds: number;
    neutralSeconds: number;
    blacklistedSeconds: number;
    productivityPercent: number;
  };
  topApps: Array<{
    appName: string | null;
    productivityTag: string;
    seconds: number;
    productiveSeconds: number;
    unproductiveSeconds: number;
    neutralSeconds: number;
    blacklistedSeconds: number;
  }>;
  topDomains: Array<{
    domain: string;
    productivityTag: string;
    seconds: number;
    productiveSeconds: number;
    unproductiveSeconds: number;
    neutralSeconds: number;
    blacklistedSeconds: number;
  }>;
  activityMetrics: {
    keyCount: number;
    mouseCount: number;
    mouseLeftKeyCount: number;
    mouseRightKeyCount: number;
    mouseMiddleKeyCount: number;
    mouseOtherKeyCount: number;
  };
  attendanceDays: Array<{
    workDate: string;
    firstLogin: Date;
    lastLogout: Date | null;
    sessionSeconds: number;
    activeSeconds: number;
    idleSeconds: number;
    sessionCount: number;
    status: string;
  }>;
}

function formatDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function generateEmployeeReportPdf(data: EmployeeReportData): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
    info: {
      Title: `Employee Report - ${data.employee.name}`,
      Author: "Centrix Employee Tracker",
    },
  });

  const primaryColor = "#0f172a";
  const secondaryColor = "#475569";
  const accentBlue = "#2563eb";
  const successColor = "#16a34a";
  const warningColor = "#d97706";
  const dangerColor = "#dc2626";
  const neutralColor = "#64748b";
  const tableBorder = "#e2e8f0";
  const tableHeaderBg = "#f8fafc";

  // --- Document Header ---
  doc.rect(40, 40, 515, 65).fill("#f1f5f9");
  doc
    .fillColor(primaryColor)
    .fontSize(18)
    .font("Helvetica-Bold")
    .text("EMPLOYEE ACTIVITY REPORT", 55, 52);
  doc
    .fillColor(secondaryColor)
    .fontSize(9)
    .font("Helvetica")
    .text(`Generated: ${new Date().toUTCString()}`, 55, 75);

  doc
    .fillColor(accentBlue)
    .fontSize(10)
    .font("Helvetica-Bold")
    .text(
      `Period: ${formatDateStr(data.period.start)} to ${formatDateStr(data.period.end)}`,
      320,
      56,
      { align: "right", width: 220 },
    );

  doc.moveDown(3);

  // --- Employee Information Box ---
  const empY = 120;
  doc.rect(40, empY, 515, 60).strokeColor(tableBorder).lineWidth(1).stroke();
  doc
    .fillColor(primaryColor)
    .fontSize(12)
    .font("Helvetica-Bold")
    .text(data.employee.name, 55, empY + 12);
  doc
    .fillColor(secondaryColor)
    .fontSize(9)
    .font("Helvetica")
    .text(`Email: ${data.employee.email}`, 55, empY + 28);
  doc
    .fillColor(secondaryColor)
    .fontSize(9)
    .font("Helvetica")
    .text(`Department: ${data.employee.department || "General"}`, 55, empY + 42);

  const deviceNames = data.employee.devices.map((d) => d.deviceName).join(", ") || "None";
  doc
    .fillColor(secondaryColor)
    .fontSize(9)
    .font("Helvetica")
    .text(`Tracked Devices: ${deviceNames}`, 320, empY + 28, { width: 220, align: "right" });

  // --- Key Summary Metrics (KPI Cards) ---
  const kpiY = 195;
  const cardW = 120;
  const cardH = 55;
  const gap = (515 - cardW * 4) / 3;

  const kpis = [
    { label: "Active Time", value: formatDuration(data.totals.activeSeconds), color: accentBlue },
    { label: "Idle Time", value: formatDuration(data.totals.idleSeconds), color: neutralColor },
    { label: "Productivity", value: `${data.totals.productivityPercent}%`, color: successColor },
    {
      label: "Keystrokes / Clicks",
      value: `${data.activityMetrics.keyCount} / ${data.activityMetrics.mouseCount}`,
      color: primaryColor,
    },
  ];

  kpis.forEach((kpi, i) => {
    const x = 40 + i * (cardW + gap);
    doc.rect(x, kpiY, cardW, cardH).fillAndStroke("#ffffff", tableBorder);
    doc
      .fillColor(secondaryColor)
      .fontSize(8)
      .font("Helvetica-Bold")
      .text(kpi.label.toUpperCase(), x + 8, kpiY + 10);
    doc
      .fillColor(kpi.color)
      .fontSize(13)
      .font("Helvetica-Bold")
      .text(kpi.value, x + 8, kpiY + 26);
  });

  // --- Productivity Breakdown Bar ---
  const barY = 265;
  doc
    .fillColor(primaryColor)
    .fontSize(11)
    .font("Helvetica-Bold")
    .text("Productivity Breakdown", 40, barY);

  const totalSecs = Math.max(1, data.totals.activeSeconds);
  const pW = (data.totals.productiveSeconds / totalSecs) * 515;
  const nW = (data.totals.neutralSeconds / totalSecs) * 515;
  const uW = (data.totals.unproductiveSeconds / totalSecs) * 515;
  const bW = (data.totals.blacklistedSeconds / totalSecs) * 515;

  let curX = 40;
  doc.rect(curX, barY + 16, pW, 10).fill(successColor);
  curX += pW;
  doc.rect(curX, barY + 16, nW, 10).fill(neutralColor);
  curX += nW;
  doc.rect(curX, barY + 16, uW, 10).fill(warningColor);
  curX += uW;
  doc.rect(curX, barY + 16, bW, 10).fill(dangerColor);

  // Legend
  const legY = barY + 32;
  const legItems = [
    { label: `Productive (${formatDuration(data.totals.productiveSeconds)})`, color: successColor },
    { label: `Neutral (${formatDuration(data.totals.neutralSeconds)})`, color: neutralColor },
    {
      label: `Unproductive (${formatDuration(data.totals.unproductiveSeconds)})`,
      color: warningColor,
    },
    {
      label: `Blacklisted (${formatDuration(data.totals.blacklistedSeconds)})`,
      color: dangerColor,
    },
  ];

  legItems.forEach((leg, idx) => {
    const lx = 40 + idx * 130;
    doc.rect(lx, legY + 2, 8, 8).fill(leg.color);
    doc
      .fillColor(secondaryColor)
      .fontSize(8)
      .font("Helvetica")
      .text(leg.label, lx + 12, legY + 2);
  });

  // --- Top Applications Table ---
  let tableY = 320;
  doc
    .fillColor(primaryColor)
    .fontSize(11)
    .font("Helvetica-Bold")
    .text("Top Applications", 40, tableY);
  tableY += 16;

  // Header
  doc.rect(40, tableY, 515, 18).fill(tableHeaderBg);
  doc.fillColor(secondaryColor).fontSize(8).font("Helvetica-Bold");
  doc.text("APPLICATION", 48, tableY + 5);
  doc.text("TAG", 220, tableY + 5);
  doc.text("PRODUCTIVE", 300, tableY + 5, { align: "right", width: 65 });
  doc.text("UNPROD/BLACK", 380, tableY + 5, { align: "right", width: 75 });
  doc.text("TOTAL TIME", 475, tableY + 5, { align: "right", width: 70 });
  tableY += 18;

  const apps = data.topApps.slice(0, 8);
  if (apps.length === 0) {
    doc
      .fillColor(secondaryColor)
      .fontSize(8)
      .font("Helvetica")
      .text("No application activity recorded in this period.", 48, tableY + 6);
    tableY += 20;
  } else {
    apps.forEach((app, idx) => {
      const isEven = idx % 2 === 0;
      if (isEven) doc.rect(40, tableY, 515, 16).fill("#fafafa");
      doc.fillColor(primaryColor).fontSize(8).font("Helvetica");
      doc.text(app.appName || "Unknown Application", 48, tableY + 4, {
        width: 165,
        lineBreak: false,
      });
      doc
        .fillColor(
          app.productivityTag === "Productive"
            ? successColor
            : app.productivityTag === "Blacklisted"
              ? dangerColor
              : app.productivityTag === "Unproductive"
                ? warningColor
                : neutralColor,
        )
        .text(app.productivityTag, 220, tableY + 4);
      doc
        .fillColor(secondaryColor)
        .text(formatDuration(app.productiveSeconds), 300, tableY + 4, {
          align: "right",
          width: 65,
        });
      const badTime = app.unproductiveSeconds + app.blacklistedSeconds;
      doc.text(badTime > 0 ? formatDuration(badTime) : "-", 380, tableY + 4, {
        align: "right",
        width: 75,
      });
      doc
        .fillColor(primaryColor)
        .font("Helvetica-Bold")
        .text(formatDuration(app.seconds), 475, tableY + 4, { align: "right", width: 70 });
      tableY += 16;
    });
  }

  // --- Top Visited Websites Table ---
  tableY += 15;
  doc
    .fillColor(primaryColor)
    .fontSize(11)
    .font("Helvetica-Bold")
    .text("Top Visited Websites", 40, tableY);
  tableY += 16;

  doc.rect(40, tableY, 515, 18).fill(tableHeaderBg);
  doc.fillColor(secondaryColor).fontSize(8).font("Helvetica-Bold");
  doc.text("DOMAIN", 48, tableY + 5);
  doc.text("TAG", 220, tableY + 5);
  doc.text("PRODUCTIVE", 300, tableY + 5, { align: "right", width: 65 });
  doc.text("UNPROD/BLACK", 380, tableY + 5, { align: "right", width: 75 });
  doc.text("TOTAL TIME", 475, tableY + 5, { align: "right", width: 70 });
  tableY += 18;

  const domains = data.topDomains.slice(0, 8);
  if (domains.length === 0) {
    doc
      .fillColor(secondaryColor)
      .fontSize(8)
      .font("Helvetica")
      .text("No web browsing activity recorded in this period.", 48, tableY + 6);
    tableY += 20;
  } else {
    domains.forEach((site, idx) => {
      const isEven = idx % 2 === 0;
      if (isEven) doc.rect(40, tableY, 515, 16).fill("#fafafa");
      doc.fillColor(primaryColor).fontSize(8).font("Helvetica");
      doc.text(site.domain, 48, tableY + 4, { width: 165, lineBreak: false });
      doc
        .fillColor(
          site.productivityTag === "Productive"
            ? successColor
            : site.productivityTag === "Blacklisted"
              ? dangerColor
              : site.productivityTag === "Unproductive"
                ? warningColor
                : neutralColor,
        )
        .text(site.productivityTag, 220, tableY + 4);
      doc
        .fillColor(secondaryColor)
        .text(formatDuration(site.productiveSeconds), 300, tableY + 4, {
          align: "right",
          width: 65,
        });
      const badTime = site.unproductiveSeconds + site.blacklistedSeconds;
      doc.text(badTime > 0 ? formatDuration(badTime) : "-", 380, tableY + 4, {
        align: "right",
        width: 75,
      });
      doc
        .fillColor(primaryColor)
        .font("Helvetica-Bold")
        .text(formatDuration(site.seconds), 475, tableY + 4, { align: "right", width: 70 });
      tableY += 16;
    });
  }

  // --- Attendance Log Summary ---
  tableY += 15;
  if (tableY > 680) {
    doc.addPage();
    tableY = 40;
  }

  doc
    .fillColor(primaryColor)
    .fontSize(11)
    .font("Helvetica-Bold")
    .text("Attendance & Presence Summary", 40, tableY);
  tableY += 16;

  doc.rect(40, tableY, 515, 18).fill(tableHeaderBg);
  doc.fillColor(secondaryColor).fontSize(8).font("Helvetica-Bold");
  doc.text("WORK DATE", 48, tableY + 5);
  doc.text("STATUS", 150, tableY + 5);
  doc.text("FIRST LOGIN", 230, tableY + 5);
  doc.text("LAST LOGOUT", 320, tableY + 5);
  doc.text("ACTIVE TIME", 410, tableY + 5, { align: "right", width: 65 });
  doc.text("SESSION TIME", 480, tableY + 5, { align: "right", width: 65 });
  tableY += 18;

  const attendance = data.attendanceDays.slice(0, 12);
  if (attendance.length === 0) {
    doc
      .fillColor(secondaryColor)
      .fontSize(8)
      .font("Helvetica")
      .text("No attendance records found for this period.", 48, tableY + 6);
    tableY += 20;
  } else {
    attendance.forEach((att, idx) => {
      const isEven = idx % 2 === 0;
      if (isEven) doc.rect(40, tableY, 515, 16).fill("#fafafa");
      doc.fillColor(primaryColor).fontSize(8).font("Helvetica");
      doc.text(att.workDate, 48, tableY + 4);
      doc
        .fillColor(att.status === "present" ? successColor : secondaryColor)
        .text(att.status.toUpperCase(), 150, tableY + 4);
      doc
        .fillColor(secondaryColor)
        .text(att.firstLogin ? att.firstLogin.toTimeString().slice(0, 8) : "-", 230, tableY + 4);
      doc.text(att.lastLogout ? att.lastLogout.toTimeString().slice(0, 8) : "-", 320, tableY + 4);
      doc
        .fillColor(primaryColor)
        .text(formatDuration(att.activeSeconds), 410, tableY + 4, { align: "right", width: 65 });
      doc
        .fillColor(primaryColor)
        .font("Helvetica-Bold")
        .text(formatDuration(att.sessionSeconds), 480, tableY + 4, { align: "right", width: 65 });
      tableY += 16;
    });
  }

  // --- Footer ---
  doc
    .fillColor(neutralColor)
    .fontSize(8)
    .font("Helvetica")
    .text("Centrix Employee Activity & Productivity Monitoring System — Confidential", 40, 780, {
      align: "center",
      width: 515,
    });

  doc.end();
  return doc;
}

export const pdfReportService = {
  generateEmployeeReportPdf,
  generateEmployeeReportPdfBuffer: async (data: EmployeeReportData): Promise<Buffer> => {
    const doc = generateEmployeeReportPdf(data);
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });
  },
};
