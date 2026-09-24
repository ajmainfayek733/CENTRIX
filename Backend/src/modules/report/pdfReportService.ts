import PDFDocument from "pdfkit";
import * as archiverModule from "archiver";
import { formatDuration } from "../../lib/format";
import { reportService } from "./reportService";

function createZipArchive() {
  const m = archiverModule as any;
  const ZipArchive = m.ZipArchive || (m.default && m.default.ZipArchive);
  if (ZipArchive) {
    return new ZipArchive({ zlib: { level: 9 } });
  }
  if (typeof m.create === "function") {
    return m.create("zip", { zlib: { level: 9 } });
  }
  if (typeof m === "function") {
    return m("zip", { zlib: { level: 9 } });
  }
  throw new Error("Unable to create zip archive: ZipArchive constructor not found");
}

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

export interface DepartmentReportData {
  department: {
    id: string;
    name: string;
    description?: string | null;
  };
  organization: {
    id: string;
    name: string;
  };
  period: {
    start: Date;
    end: Date;
  };
  headcount: number;
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
  members: Array<{
    employee: {
      id: string;
      name: string;
      email: string;
      status: string;
      department?: string | null;
    };
    deviceCount: number;
    totals: {
      activeSeconds: number;
      idleSeconds: number;
      productiveSeconds: number;
      unproductiveSeconds: number;
      neutralSeconds: number;
      blacklistedSeconds: number;
      productivityPercent: number;
    };
  }>;
}

function formatDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const PRIMARY_COLOR = "#0f172a";
const SECONDARY_COLOR = "#475569";
const ACCENT_BLUE = "#2563eb";
const SUCCESS_COLOR = "#16a34a";
const WARNING_COLOR = "#d97706";
const DANGER_COLOR = "#dc2626";
const NEUTRAL_COLOR = "#64748b";
const TABLE_BORDER = "#e2e8f0";
const TABLE_HEADER_BG = "#f8fafc";
const CARD_BG = "#f8fafc";

// ---------------------------------------------------------------------------
// Individual Employee Report PDF
// ---------------------------------------------------------------------------

export function generateEmployeeReportPdf(data: EmployeeReportData): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
    autoFirstPage: true,
    info: {
      Title: `Employee Report - ${data.employee.name}`,
      Author: "Centrix Employee Tracker",
    },
  });

  // ================= PAGE 1 =================
  // Header Banner
  doc.rect(40, 40, 515, 60).fill("#f1f5f9");
  doc
    .fillColor(PRIMARY_COLOR)
    .fontSize(16)
    .font("Helvetica-Bold")
    .text("EMPLOYEE ACTIVITY REPORT", 55, 52);
  doc
    .fillColor(SECONDARY_COLOR)
    .fontSize(8.5)
    .font("Helvetica")
    .text(`Generated: ${new Date().toUTCString()}`, 55, 74);
  doc
    .fillColor(ACCENT_BLUE)
    .fontSize(9.5)
    .font("Helvetica-Bold")
    .text(
      `Period: ${formatDateStr(data.period.start)} to ${formatDateStr(data.period.end)}`,
      320,
      55,
      {
        align: "right",
        width: 220,
      },
    );

  // Employee Information Box
  const empY = 110;
  doc.rect(40, empY, 515, 50).strokeColor(TABLE_BORDER).lineWidth(1).stroke();
  doc
    .fillColor(PRIMARY_COLOR)
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(data.employee.name, 55, empY + 10);
  doc
    .fillColor(SECONDARY_COLOR)
    .fontSize(8.5)
    .font("Helvetica")
    .text(`Email: ${data.employee.email}`, 55, empY + 24);
  doc.text(`Department: ${data.employee.department || "General"}`, 55, empY + 36);

  const deviceNames = data.employee.devices.map((d) => d.deviceName).join(", ") || "None";
  doc.text(`Tracked Devices: ${deviceNames}`, 300, empY + 24, { width: 240, align: "right" });

  // Key KPI Cards
  const kpiY = 170;
  const cardW = 120;
  const cardH = 50;
  const gap = (515 - cardW * 4) / 3;

  const kpis = [
    { label: "Active Time", value: formatDuration(data.totals.activeSeconds), color: ACCENT_BLUE },
    { label: "Idle Time", value: formatDuration(data.totals.idleSeconds), color: NEUTRAL_COLOR },
    { label: "Productivity", value: `${data.totals.productivityPercent}%`, color: SUCCESS_COLOR },
    {
      label: "Keys / Clicks",
      value: `${data.activityMetrics.keyCount.toLocaleString()} / ${data.activityMetrics.mouseCount.toLocaleString()}`,
      color: PRIMARY_COLOR,
    },
  ];

  kpis.forEach((kpi, i) => {
    const x = 40 + i * (cardW + gap);
    doc.rect(x, kpiY, cardW, cardH).fillAndStroke("#ffffff", TABLE_BORDER);
    doc
      .fillColor(SECONDARY_COLOR)
      .fontSize(7.5)
      .font("Helvetica-Bold")
      .text(kpi.label.toUpperCase(), x + 8, kpiY + 8);
    doc
      .fillColor(kpi.color)
      .fontSize(12)
      .font("Helvetica-Bold")
      .text(kpi.value, x + 8, kpiY + 23);
  });

  // Productivity Breakdown Bar
  const barY = 230;
  doc
    .fillColor(PRIMARY_COLOR)
    .fontSize(10)
    .font("Helvetica-Bold")
    .text("Productivity Breakdown", 40, barY);

  const totalSecs = Math.max(1, data.totals.activeSeconds);
  const pW = (data.totals.productiveSeconds / totalSecs) * 515;
  const nW = (data.totals.neutralSeconds / totalSecs) * 515;
  const uW = (data.totals.unproductiveSeconds / totalSecs) * 515;
  const bW = (data.totals.blacklistedSeconds / totalSecs) * 515;

  let curX = 40;
  doc.rect(curX, barY + 14, pW, 8).fill(SUCCESS_COLOR);
  curX += pW;
  doc.rect(curX, barY + 14, nW, 8).fill(NEUTRAL_COLOR);
  curX += nW;
  doc.rect(curX, barY + 14, uW, 8).fill(WARNING_COLOR);
  curX += uW;
  doc.rect(curX, barY + 14, bW, 8).fill(DANGER_COLOR);

  // Legend
  const legY = barY + 26;
  const legItems = [
    { label: `Productive: ${formatDuration(data.totals.productiveSeconds)}`, color: SUCCESS_COLOR },
    { label: `Neutral: ${formatDuration(data.totals.neutralSeconds)}`, color: NEUTRAL_COLOR },
    {
      label: `Unproductive: ${formatDuration(data.totals.unproductiveSeconds)}`,
      color: WARNING_COLOR,
    },
    {
      label: `Blacklisted: ${formatDuration(data.totals.blacklistedSeconds)}`,
      color: DANGER_COLOR,
    },
  ];

  legItems.forEach((leg, idx) => {
    const lx = 40 + idx * 130;
    doc.rect(lx, legY + 2, 6, 6).fill(leg.color);
    doc
      .fillColor(SECONDARY_COLOR)
      .fontSize(7.5)
      .font("Helvetica")
      .text(leg.label, lx + 10, legY + 2);
  });

  // Top Applications Table (Top 6)
  let tableY = 280;
  doc
    .fillColor(PRIMARY_COLOR)
    .fontSize(10)
    .font("Helvetica-Bold")
    .text("Top Applications", 40, tableY);
  tableY += 14;

  doc.rect(40, tableY, 515, 16).fill(TABLE_HEADER_BG);
  doc.fillColor(SECONDARY_COLOR).fontSize(7.5).font("Helvetica-Bold");
  doc.text("APPLICATION", 48, tableY + 4);
  doc.text("TAG", 220, tableY + 4);
  doc.text("PRODUCTIVE", 300, tableY + 4, { align: "right", width: 65 });
  doc.text("UNPROD/BLACK", 380, tableY + 4, { align: "right", width: 75 });
  doc.text("TOTAL TIME", 475, tableY + 4, { align: "right", width: 70 });
  tableY += 16;

  const apps = data.topApps.slice(0, 6);
  if (apps.length === 0) {
    doc
      .fillColor(SECONDARY_COLOR)
      .fontSize(7.5)
      .font("Helvetica")
      .text("No application activity recorded in this period.", 48, tableY + 4);
    tableY += 16;
  } else {
    apps.forEach((app, idx) => {
      if (idx % 2 === 0) doc.rect(40, tableY, 515, 14).fill("#fafafa");
      doc.fillColor(PRIMARY_COLOR).fontSize(7.5).font("Helvetica");
      doc.text(app.appName || "Unknown Application", 48, tableY + 3, {
        width: 165,
        lineBreak: false,
      });
      doc
        .fillColor(
          app.productivityTag === "Productive"
            ? SUCCESS_COLOR
            : app.productivityTag === "Blacklisted"
              ? DANGER_COLOR
              : app.productivityTag === "Unproductive"
                ? WARNING_COLOR
                : NEUTRAL_COLOR,
        )
        .font("Helvetica-Bold")
        .text(app.productivityTag, 220, tableY + 3);
      doc
        .fillColor(SECONDARY_COLOR)
        .font("Helvetica")
        .text(formatDuration(app.productiveSeconds), 300, tableY + 3, {
          align: "right",
          width: 65,
        });
      const badTime = app.unproductiveSeconds + app.blacklistedSeconds;
      doc.text(badTime > 0 ? formatDuration(badTime) : "-", 380, tableY + 3, {
        align: "right",
        width: 75,
      });
      doc
        .fillColor(PRIMARY_COLOR)
        .font("Helvetica-Bold")
        .text(formatDuration(app.seconds), 475, tableY + 3, { align: "right", width: 70 });
      tableY += 14;
    });
  }

  // Top Visited Websites Table (Top 6)
  tableY += 12;
  doc
    .fillColor(PRIMARY_COLOR)
    .fontSize(10)
    .font("Helvetica-Bold")
    .text("Top Visited Websites", 40, tableY);
  tableY += 14;

  doc.rect(40, tableY, 515, 16).fill(TABLE_HEADER_BG);
  doc.fillColor(SECONDARY_COLOR).fontSize(7.5).font("Helvetica-Bold");
  doc.text("DOMAIN", 48, tableY + 4);
  doc.text("TAG", 220, tableY + 4);
  doc.text("PRODUCTIVE", 300, tableY + 4, { align: "right", width: 65 });
  doc.text("UNPROD/BLACK", 380, tableY + 4, { align: "right", width: 75 });
  doc.text("TOTAL TIME", 475, tableY + 4, { align: "right", width: 70 });
  tableY += 16;

  const domains = data.topDomains.slice(0, 6);
  if (domains.length === 0) {
    doc
      .fillColor(SECONDARY_COLOR)
      .fontSize(7.5)
      .font("Helvetica")
      .text("No web browsing recorded in this period.", 48, tableY + 4);
    tableY += 16;
  } else {
    domains.forEach((site, idx) => {
      if (idx % 2 === 0) doc.rect(40, tableY, 515, 14).fill("#fafafa");
      doc.fillColor(PRIMARY_COLOR).fontSize(7.5).font("Helvetica");
      doc.text(site.domain, 48, tableY + 3, { width: 165, lineBreak: false });
      doc
        .fillColor(
          site.productivityTag === "Productive"
            ? SUCCESS_COLOR
            : site.productivityTag === "Blacklisted"
              ? DANGER_COLOR
              : site.productivityTag === "Unproductive"
                ? WARNING_COLOR
                : NEUTRAL_COLOR,
        )
        .font("Helvetica-Bold")
        .text(site.productivityTag, 220, tableY + 3);
      doc
        .fillColor(SECONDARY_COLOR)
        .font("Helvetica")
        .text(formatDuration(site.productiveSeconds), 300, tableY + 3, {
          align: "right",
          width: 65,
        });
      const badTime = site.unproductiveSeconds + site.blacklistedSeconds;
      doc.text(badTime > 0 ? formatDuration(badTime) : "-", 380, tableY + 3, {
        align: "right",
        width: 75,
      });
      doc
        .fillColor(PRIMARY_COLOR)
        .font("Helvetica-Bold")
        .text(formatDuration(site.seconds), 475, tableY + 3, { align: "right", width: 70 });
      tableY += 14;
    });
  }

  // Activity Metrics Summary Bar
  tableY += 12;
  doc.rect(40, tableY, 515, 32).fillAndStroke(CARD_BG, TABLE_BORDER);
  doc
    .fillColor(SECONDARY_COLOR)
    .fontSize(7.5)
    .font("Helvetica-Bold")
    .text("ACTIVITY METRICS BREAKDOWN", 48, tableY + 6);
  doc
    .fillColor(PRIMARY_COLOR)
    .fontSize(7.5)
    .font("Helvetica")
    .text(
      `Keyboard: ${data.activityMetrics.keyCount.toLocaleString()} keystrokes   |   Mouse Total: ${data.activityMetrics.mouseCount.toLocaleString()}   (Left: ${data.activityMetrics.mouseLeftKeyCount.toLocaleString()}, Right: ${data.activityMetrics.mouseRightKeyCount.toLocaleString()}, Mid/Other: ${(data.activityMetrics.mouseMiddleKeyCount + data.activityMetrics.mouseOtherKeyCount).toLocaleString()})`,
      48,
      tableY + 18,
    );

  // Page 1 Footer
  doc
    .fillColor(NEUTRAL_COLOR)
    .fontSize(7.5)
    .font("Helvetica")
    .text("Centrix Employee Activity Monitoring — Confidential", 40, 785, {
      align: "center",
      width: 515,
    });

  // ================= PAGE 2 (Attendance & Daily Log) =================
  if (data.attendanceDays && data.attendanceDays.length > 0) {
    doc.addPage();
    tableY = 40;

    // Page 2 Header Banner
    doc.rect(40, 40, 515, 45).fill("#f1f5f9");
    doc
      .fillColor(PRIMARY_COLOR)
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("ATTENDANCE & DAILY PRESENCE LOG", 55, 50);
    doc
      .fillColor(SECONDARY_COLOR)
      .fontSize(8.5)
      .font("Helvetica")
      .text(
        `${data.employee.name} (${data.employee.email}) — ${formatDateStr(data.period.start)} to ${formatDateStr(data.period.end)}`,
        55,
        68,
      );

    let attY = 95;
    doc.rect(40, attY, 515, 16).fill(TABLE_HEADER_BG);
    doc.fillColor(SECONDARY_COLOR).fontSize(7.5).font("Helvetica-Bold");
    doc.text("WORK DATE", 48, attY + 4);
    doc.text("STATUS", 130, attY + 4);
    doc.text("FIRST LOGIN", 205, attY + 4);
    doc.text("LAST LOGOUT", 295, attY + 4);
    doc.text("SESSIONS", 385, attY + 4, { align: "right", width: 50 });
    doc.text("ACTIVE TIME", 445, attY + 4, { align: "right", width: 50 });
    doc.text("TOTAL TIME", 500, attY + 4, { align: "right", width: 50 });
    attY += 16;

    const maxRows = Math.min(data.attendanceDays.length, 38);
    for (let i = 0; i < maxRows; i++) {
      const att = data.attendanceDays[i];
      if (attY > 760) break;

      if (i % 2 === 0) doc.rect(40, attY, 515, 14).fill("#fafafa");
      doc.fillColor(PRIMARY_COLOR).fontSize(7.5).font("Helvetica");
      doc.text(att.workDate, 48, attY + 3);
      doc
        .fillColor(att.status === "present" ? SUCCESS_COLOR : SECONDARY_COLOR)
        .font("Helvetica-Bold")
        .text(att.status.toUpperCase(), 130, attY + 3);
      doc
        .fillColor(SECONDARY_COLOR)
        .font("Helvetica")
        .text(
          att.firstLogin ? new Date(att.firstLogin).toTimeString().slice(0, 8) : "-",
          205,
          attY + 3,
        );
      doc.text(
        att.lastLogout ? new Date(att.lastLogout).toTimeString().slice(0, 8) : "-",
        295,
        attY + 3,
      );
      doc.text(att.sessionCount ? att.sessionCount.toString() : "1", 385, attY + 3, {
        align: "right",
        width: 50,
      });
      doc
        .fillColor(PRIMARY_COLOR)
        .text(formatDuration(att.activeSeconds), 445, attY + 3, { align: "right", width: 50 });
      doc
        .font("Helvetica-Bold")
        .text(formatDuration(att.sessionSeconds), 500, attY + 3, { align: "right", width: 50 });
      attY += 14;
    }

    doc
      .fillColor(NEUTRAL_COLOR)
      .fontSize(7.5)
      .font("Helvetica")
      .text("Centrix Employee Activity Monitoring — Confidential", 40, 785, {
        align: "center",
        width: 515,
      });
  }

  doc.end();
  return doc;
}

// ---------------------------------------------------------------------------
// Department Performance Report PDF
// ---------------------------------------------------------------------------

export function generateDepartmentReportPdf(data: DepartmentReportData): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
    autoFirstPage: true,
    info: {
      Title: `Department Performance - ${data.department.name}`,
      Author: "Centrix Employee Tracker",
    },
  });

  // ================= PAGE 1 =================
  // Header Banner
  doc.rect(40, 40, 515, 60).fill("#f1f5f9");
  doc
    .fillColor(PRIMARY_COLOR)
    .fontSize(16)
    .font("Helvetica-Bold")
    .text("DEPARTMENT PERFORMANCE REPORT", 55, 52);
  doc
    .fillColor(SECONDARY_COLOR)
    .fontSize(8.5)
    .font("Helvetica")
    .text(
      `Organization: ${data.organization.name}   |   Generated: ${new Date().toUTCString()}`,
      55,
      74,
    );
  doc
    .fillColor(ACCENT_BLUE)
    .fontSize(9.5)
    .font("Helvetica-Bold")
    .text(
      `Period: ${formatDateStr(data.period.start)} to ${formatDateStr(data.period.end)}`,
      320,
      55,
      {
        align: "right",
        width: 220,
      },
    );

  // Department Info Box
  const deptY = 110;
  doc.rect(40, deptY, 515, 50).strokeColor(TABLE_BORDER).lineWidth(1).stroke();
  doc
    .fillColor(PRIMARY_COLOR)
    .fontSize(12)
    .font("Helvetica-Bold")
    .text(data.department.name, 55, deptY + 10);
  doc
    .fillColor(SECONDARY_COLOR)
    .fontSize(8.5)
    .font("Helvetica")
    .text(data.department.description || "Active department", 55, deptY + 26);
  doc.text(`Team Size: ${data.headcount} employee(s)`, 350, deptY + 18, {
    width: 190,
    align: "right",
  });

  // Key KPI Cards
  const kpiY = 170;
  const cardW = 120;
  const cardH = 50;
  const gap = (515 - cardW * 4) / 3;

  const kpis = [
    {
      label: "Total Active Time",
      value: formatDuration(data.totals.activeSeconds),
      color: ACCENT_BLUE,
    },
    {
      label: "Total Idle Time",
      value: formatDuration(data.totals.idleSeconds),
      color: NEUTRAL_COLOR,
    },
    {
      label: "Dept Productivity",
      value: `${data.totals.productivityPercent}%`,
      color: SUCCESS_COLOR,
    },
    {
      label: "Keys / Clicks",
      value: `${data.activityMetrics.keyCount.toLocaleString()} / ${data.activityMetrics.mouseCount.toLocaleString()}`,
      color: PRIMARY_COLOR,
    },
  ];

  kpis.forEach((kpi, i) => {
    const x = 40 + i * (cardW + gap);
    doc.rect(x, kpiY, cardW, cardH).fillAndStroke("#ffffff", TABLE_BORDER);
    doc
      .fillColor(SECONDARY_COLOR)
      .fontSize(7.5)
      .font("Helvetica-Bold")
      .text(kpi.label.toUpperCase(), x + 8, kpiY + 8);
    doc
      .fillColor(kpi.color)
      .fontSize(12)
      .font("Helvetica-Bold")
      .text(kpi.value, x + 8, kpiY + 23);
  });

  // Productivity Breakdown Bar
  const barY = 230;
  doc
    .fillColor(PRIMARY_COLOR)
    .fontSize(10)
    .font("Helvetica-Bold")
    .text("Department Productivity Mix", 40, barY);

  const totalSecs = Math.max(1, data.totals.activeSeconds);
  const pW = (data.totals.productiveSeconds / totalSecs) * 515;
  const nW = (data.totals.neutralSeconds / totalSecs) * 515;
  const uW = (data.totals.unproductiveSeconds / totalSecs) * 515;
  const bW = (data.totals.blacklistedSeconds / totalSecs) * 515;

  let curX = 40;
  doc.rect(curX, barY + 14, pW, 8).fill(SUCCESS_COLOR);
  curX += pW;
  doc.rect(curX, barY + 14, nW, 8).fill(NEUTRAL_COLOR);
  curX += nW;
  doc.rect(curX, barY + 14, uW, 8).fill(WARNING_COLOR);
  curX += uW;
  doc.rect(curX, barY + 14, bW, 8).fill(DANGER_COLOR);

  // Legend
  const legY = barY + 26;
  const legItems = [
    { label: `Productive: ${formatDuration(data.totals.productiveSeconds)}`, color: SUCCESS_COLOR },
    { label: `Neutral: ${formatDuration(data.totals.neutralSeconds)}`, color: NEUTRAL_COLOR },
    {
      label: `Unproductive: ${formatDuration(data.totals.unproductiveSeconds)}`,
      color: WARNING_COLOR,
    },
    {
      label: `Blacklisted: ${formatDuration(data.totals.blacklistedSeconds)}`,
      color: DANGER_COLOR,
    },
  ];

  legItems.forEach((leg, idx) => {
    const lx = 40 + idx * 130;
    doc.rect(lx, legY + 2, 6, 6).fill(leg.color);
    doc
      .fillColor(SECONDARY_COLOR)
      .fontSize(7.5)
      .font("Helvetica")
      .text(leg.label, lx + 10, legY + 2);
  });

  // Department Top Applications Table (Top 6)
  let tableY = 280;
  doc
    .fillColor(PRIMARY_COLOR)
    .fontSize(10)
    .font("Helvetica-Bold")
    .text("Department Top Applications", 40, tableY);
  tableY += 14;

  doc.rect(40, tableY, 515, 16).fill(TABLE_HEADER_BG);
  doc.fillColor(SECONDARY_COLOR).fontSize(7.5).font("Helvetica-Bold");
  doc.text("APPLICATION", 48, tableY + 4);
  doc.text("TAG", 220, tableY + 4);
  doc.text("PRODUCTIVE", 300, tableY + 4, { align: "right", width: 65 });
  doc.text("UNPROD/BLACK", 380, tableY + 4, { align: "right", width: 75 });
  doc.text("TOTAL TIME", 475, tableY + 4, { align: "right", width: 70 });
  tableY += 16;

  const apps = data.topApps.slice(0, 6);
  if (apps.length === 0) {
    doc
      .fillColor(SECONDARY_COLOR)
      .fontSize(7.5)
      .font("Helvetica")
      .text("No application activity recorded in this department.", 48, tableY + 4);
    tableY += 16;
  } else {
    apps.forEach((app, idx) => {
      if (idx % 2 === 0) doc.rect(40, tableY, 515, 14).fill("#fafafa");
      doc.fillColor(PRIMARY_COLOR).fontSize(7.5).font("Helvetica");
      doc.text(app.appName || "Unknown Application", 48, tableY + 3, {
        width: 165,
        lineBreak: false,
      });
      doc
        .fillColor(
          app.productivityTag === "Productive"
            ? SUCCESS_COLOR
            : app.productivityTag === "Blacklisted"
              ? DANGER_COLOR
              : app.productivityTag === "Unproductive"
                ? WARNING_COLOR
                : NEUTRAL_COLOR,
        )
        .font("Helvetica-Bold")
        .text(app.productivityTag, 220, tableY + 3);
      doc
        .fillColor(SECONDARY_COLOR)
        .font("Helvetica")
        .text(formatDuration(app.productiveSeconds), 300, tableY + 3, {
          align: "right",
          width: 65,
        });
      const badTime = app.unproductiveSeconds + app.blacklistedSeconds;
      doc.text(badTime > 0 ? formatDuration(badTime) : "-", 380, tableY + 3, {
        align: "right",
        width: 75,
      });
      doc
        .fillColor(PRIMARY_COLOR)
        .font("Helvetica-Bold")
        .text(formatDuration(app.seconds), 475, tableY + 3, { align: "right", width: 70 });
      tableY += 14;
    });
  }

  // Department Top Visited Websites Table (Top 6)
  tableY += 12;
  doc
    .fillColor(PRIMARY_COLOR)
    .fontSize(10)
    .font("Helvetica-Bold")
    .text("Department Top Websites", 40, tableY);
  tableY += 14;

  doc.rect(40, tableY, 515, 16).fill(TABLE_HEADER_BG);
  doc.fillColor(SECONDARY_COLOR).fontSize(7.5).font("Helvetica-Bold");
  doc.text("DOMAIN", 48, tableY + 4);
  doc.text("TAG", 220, tableY + 4);
  doc.text("PRODUCTIVE", 300, tableY + 4, { align: "right", width: 65 });
  doc.text("UNPROD/BLACK", 380, tableY + 4, { align: "right", width: 75 });
  doc.text("TOTAL TIME", 475, tableY + 4, { align: "right", width: 70 });
  tableY += 16;

  const domains = data.topDomains.slice(0, 6);
  if (domains.length === 0) {
    doc
      .fillColor(SECONDARY_COLOR)
      .fontSize(7.5)
      .font("Helvetica")
      .text("No web browsing recorded in this department.", 48, tableY + 4);
    tableY += 16;
  } else {
    domains.forEach((site, idx) => {
      if (idx % 2 === 0) doc.rect(40, tableY, 515, 14).fill("#fafafa");
      doc.fillColor(PRIMARY_COLOR).fontSize(7.5).font("Helvetica");
      doc.text(site.domain, 48, tableY + 3, { width: 165, lineBreak: false });
      doc
        .fillColor(
          site.productivityTag === "Productive"
            ? SUCCESS_COLOR
            : site.productivityTag === "Blacklisted"
              ? DANGER_COLOR
              : site.productivityTag === "Unproductive"
                ? WARNING_COLOR
                : NEUTRAL_COLOR,
        )
        .font("Helvetica-Bold")
        .text(site.productivityTag, 220, tableY + 3);
      doc
        .fillColor(SECONDARY_COLOR)
        .font("Helvetica")
        .text(formatDuration(site.productiveSeconds), 300, tableY + 3, {
          align: "right",
          width: 65,
        });
      const badTime = site.unproductiveSeconds + site.blacklistedSeconds;
      doc.text(badTime > 0 ? formatDuration(badTime) : "-", 380, tableY + 3, {
        align: "right",
        width: 75,
      });
      doc
        .fillColor(PRIMARY_COLOR)
        .font("Helvetica-Bold")
        .text(formatDuration(site.seconds), 475, tableY + 3, { align: "right", width: 70 });
      tableY += 14;
    });
  }

  // Page 1 Footer
  doc
    .fillColor(NEUTRAL_COLOR)
    .fontSize(7.5)
    .font("Helvetica")
    .text("Centrix Employee Activity Monitoring — Confidential", 40, 785, {
      align: "center",
      width: 515,
    });

  // ================= PAGE 2 (Team Member Roster Breakdown) =================
  if (data.members && data.members.length > 0) {
    doc.addPage();

    // Page 2 Header Banner
    doc.rect(40, 40, 515, 45).fill("#f1f5f9");
    doc
      .fillColor(PRIMARY_COLOR)
      .fontSize(13)
      .font("Helvetica-Bold")
      .text("TEAM MEMBER PERFORMANCE BREAKDOWN", 55, 50);
    doc
      .fillColor(SECONDARY_COLOR)
      .fontSize(8.5)
      .font("Helvetica")
      .text(
        `${data.department.name} (${data.members.length} member(s)) — ${formatDateStr(data.period.start)} to ${formatDateStr(data.period.end)}`,
        55,
        68,
      );

    let memY = 95;
    doc.rect(40, memY, 515, 16).fill(TABLE_HEADER_BG);
    doc.fillColor(SECONDARY_COLOR).fontSize(7.5).font("Helvetica-Bold");
    doc.text("EMPLOYEE", 48, memY + 4);
    doc.text("EMAIL", 160, memY + 4);
    doc.text("DEVICES", 280, memY + 4, { align: "right", width: 45 });
    doc.text("ACTIVE TIME", 340, memY + 4, { align: "right", width: 60 });
    doc.text("IDLE TIME", 410, memY + 4, { align: "right", width: 55 });
    doc.text("PRODUCTIVITY", 475, memY + 4, { align: "right", width: 70 });
    memY += 16;

    const maxMembers = Math.min(data.members.length, 38);
    for (let i = 0; i < maxMembers; i++) {
      const m = data.members[i];
      if (memY > 760) break;

      if (i % 2 === 0) doc.rect(40, memY, 515, 14).fill("#fafafa");
      doc.fillColor(PRIMARY_COLOR).fontSize(7.5).font("Helvetica");
      doc.text(m.employee.name, 48, memY + 3, { width: 110, lineBreak: false });
      doc
        .fillColor(SECONDARY_COLOR)
        .text(m.employee.email, 160, memY + 3, { width: 115, lineBreak: false });
      doc.text(m.deviceCount.toString(), 280, memY + 3, { align: "right", width: 45 });
      doc
        .fillColor(PRIMARY_COLOR)
        .text(formatDuration(m.totals.activeSeconds), 340, memY + 3, { align: "right", width: 60 });
      doc
        .fillColor(SECONDARY_COLOR)
        .text(formatDuration(m.totals.idleSeconds), 410, memY + 3, { align: "right", width: 55 });
      doc
        .fillColor(m.totals.productivityPercent >= 60 ? SUCCESS_COLOR : WARNING_COLOR)
        .font("Helvetica-Bold")
        .text(`${m.totals.productivityPercent}%`, 475, memY + 3, { align: "right", width: 70 });
      memY += 14;
    }

    doc
      .fillColor(NEUTRAL_COLOR)
      .fontSize(7.5)
      .font("Helvetica")
      .text("Centrix Employee Activity Monitoring — Confidential", 40, 785, {
        align: "center",
        width: 515,
      });
  }

  doc.end();
  return doc;
}

// ---------------------------------------------------------------------------
// Buffer & ZIP Generators
// ---------------------------------------------------------------------------

export async function generateEmployeeReportPdfBuffer(data: EmployeeReportData): Promise<Buffer> {
  const doc = generateEmployeeReportPdf(data);
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

export async function generateDepartmentReportPdfBuffer(
  data: DepartmentReportData,
): Promise<Buffer> {
  const doc = generateDepartmentReportPdf(data);
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

/**
 * Generates a ZIP archive containing:
 * 1. 00_department_summary_[dept].pdf
 * 2. Individual employee PDF reports for every member in that department.
 */
export async function generateDepartmentBatchZipBuffer(
  departmentId: string,
  startDate?: string,
  endDate?: string,
): Promise<Buffer> {
  const deptDetail = await reportService.getDepartmentDetail(departmentId, startDate, endDate);
  const deptPdfBuffer = await generateDepartmentReportPdfBuffer(deptDetail as any);

  const archive = createZipArchive();
  const chunks: Buffer[] = [];

  const zipPromise = new Promise<Buffer>((resolve, reject) => {
    archive.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
  });

  const safeDeptName = (deptDetail.department.name || "department")
    .replace(/[^a-z0-9_-]/gi, "_")
    .toLowerCase();
  const dateStr = formatDateStr(deptDetail.period.start);

  // 1. Append Department Summary PDF
  archive.append(deptPdfBuffer, {
    name: `00_department_summary_${safeDeptName}_${dateStr}.pdf`,
  });

  // 2. Append each individual team member's PDF report
  for (const member of deptDetail.members) {
    try {
      const empData = await reportService.getEmployeeDetail(member.employee.id, startDate, endDate);
      const empPdfBuffer = await generateEmployeeReportPdfBuffer(empData);
      const safeEmpName = member.employee.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
      archive.append(empPdfBuffer, {
        name: `employee_${safeEmpName}_${dateStr}.pdf`,
      });
    } catch (err) {
      console.error(
        `generateDepartmentBatchZipBuffer: skipped employee ${member.employee.id}:`,
        err,
      );
    }
  }

  await archive.finalize();
  return zipPromise;
}

export const pdfReportService = {
  generateEmployeeReportPdf,
  generateEmployeeReportPdfBuffer,
  generateDepartmentReportPdf,
  generateDepartmentReportPdfBuffer,
  generateDepartmentBatchZipBuffer,
};
