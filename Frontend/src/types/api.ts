/**
 * Mirrors the backend's response DTOs field for field.
 *
 * A drifted type here does not fail the build - it silently renders `undefined` in a report.
 * Treat any contract change as a two-repo commit, as Docs/frontend/spec.md section 8 says.
 */

export type ProductivityTag = 'Productive' | 'Unproductive' | 'Blacklisted' | 'Neutral';
export type ActivityType = 'Application' | 'Desktop' | 'Locked' | 'Idle' | 'Sleeping' | 'Disconnected';
export type AlertSeverity = 'Information' | 'Warning' | 'High' | 'Critical';
export type AlertState = 'New' | 'Shown' | 'Acknowledged' | 'Resolved' | 'Archived';
export type CategoryTarget = 'Application' | 'Domain';

export interface Totals {
  activeSeconds: number;
  idleSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  blacklistedSeconds: number;
  productivityPercent: number;
}

export interface Overview {
  period: { start: string; end: string };
  headcount: number;
  employeesTracked: number;
  onlineNow: number;
  openHighSeverityAlerts: number;
  attendanceToday: { checkedIn: number; stillActive: number };
  totals: Totals;
}

export interface RosterEmployee extends Totals {
  id: string;
  name: string;
  email: string;
  department: string | null;
  status: string;
  deviceCount: number;
  lastSeen: string | null;
  isOnline: boolean;
}

export interface Roster {
  period: { start: string; end: string };
  employees: RosterEmployee[];
}

export interface BrowserVisitRow {
  id: string;
  activitySessionId: string | null;
  browser: string;
  domain: string;
  rawUrl: string;
  pageTitle: string | null;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  productivityTag: ProductivityTag;
}

export interface TimelineRow {
  id: string;
  activitySessionId: string;
  appName: string | null;
  processName: string | null;
  type: ActivityType;
  windowTitle: string | null;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  reason: string | null;
  productivityTag: ProductivityTag;
  visits: BrowserVisitRow[];
}

/**
 * One page of a keyset-paginated feed, matching the backend's `Page<T>`.
 *
 * `nextCursor` is opaque: the client hands it straight back to ask for the following page and
 * never parses it. That is what lets the server change the sort key without a client release.
 */
export interface LogPageOf<T> {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AttendanceRow {
  sessionId: string;
  loginTime: string;
  logoutTime: string | null;
  endReason: string | null;
  workDate: string;
}

export interface EmployeeDetail {
  employee: {
    id: string;
    name: string;
    email: string;
    department: string | null;
    devices: Array<{ id: string; deviceName: string; lastSeen: string | null; agentVersion: string | null }>;
  };
  period: { start: string; end: string };
  totals: Totals;
  /**
   * First page only. `totals` above is not derived from it - it comes from the daily rollup, so
   * the percentages describe the whole period rather than whatever rows happen to be loaded.
   */
  timeline: LogPageOf<TimelineRow>;
  topApps: Array<{ appName: string | null; productivityTag: ProductivityTag; seconds: number }>;
  topDomains: Array<{ domain: string; productivityTag: ProductivityTag; seconds: number }>;
  attendance: AttendanceRow[];
}

/**
 * One capture in the screenshot index. The bytes are not in here - `deviceId` and `clientEventId`
 * address the image, which is fetched (and audit-logged) one request at a time when displayed.
 *
 * width/height are nullable because an older agent may not have reported them; the gallery must
 * not assume an aspect ratio from them.
 */
export interface ScreenshotRow {
  id: string;
  deviceId: string;
  deviceName: string | null;
  clientEventId: string;
  capturedAt: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
}

export interface AlertRow {
  id: string;
  clientEventId: string;
  type: string;
  severity: AlertSeverity;
  state: AlertState;
  title: string;
  message: string;
  idleSeconds: number | null;
  thresholdSeconds: number | null;
  contextAppName: string | null;
  contextDomain: string | null;
  contextUrl: string | null;
  contextUsbFriendlyName: string | null;
  triggeredAt: string;
  resolvedAt: string | null;
  escalationLevel: number;
  device: { deviceName: string; employee: { id: string; name: string } };
}

export interface UsbEventRow {
  id: string;
  eventType: 'Connected' | 'Disconnected';
  deviceType: string;
  friendlyName: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  driveLetter: string | null;
  volumeLabel: string | null;
  /** Decimal string: capacities exceed JSON's safe integer range. */
  capacityBytes: string | null;
  fileSystem: string | null;
  eventTime: string;
  device: { deviceName: string; employee: { id: string; name: string } };
}

/**
 * Roster entry from GET /v1/dashboard/employees. The backend already filters out the
 * "Unassigned Devices" placeholder, so every row here is a real person a device can be
 * assigned to.
 */
export interface EmployeeSummary {
  id: string;
  name: string;
  email: string;
  department: string | null;
  status: string;
}

export interface DeviceRow {
  id: string;
  deviceId: string;
  deviceName: string;
  systemType: string | null;
  edition: string | null;
  version: string | null;
  macAddress: string | null;
  agentVersion: string | null;
  isActive: boolean;
  lastSeen: string | null;
  createdAt: string;
  employee: { id: string; name: string; status: string };
}

export interface CategoryRow {
  id: string;
  pattern: string;
  target: CategoryTarget;
  tag: ProductivityTag;
  isBlacklisted: boolean;
}

export interface Policy {
  version: number;
  attendance: { enabled: boolean };
  activity: { enabled: boolean; idleThresholdSeconds: number };
  appSession: { enabled: boolean; pollSeconds: number };
  browserMonitor: { enabled: boolean; uiaTimeoutMs: number; maxRetryAttempts: number };
  screenshot: { enabled: boolean; intervalSeconds: number; jpegQuality: number };
  usb: { enabled: boolean; reconciliationIntervalSeconds: number; alertOnInsertion: boolean };
  alert: {
    enabled: boolean;
    idle: {
      enabled: boolean;
      normalSeconds: number;
      moderateSeconds: number;
      severeSeconds: number;
      renotifySeconds: number;
    };
    blacklistEnabled: boolean;
    notifyOutsideWorkingHours: boolean;
  };
  sync: {
    batchIntervalSeconds: number;
    maxBatchSize: number;
    minRetryBackoffSeconds: number;
    maxRetryBackoffSeconds: number;
  };
  /**
   * Socket.IO signalling. `heartbeatSeconds` is how often a connected agent proves it is alive,
   * which is what the dashboard's "Active now" is derived from.
   */
  realtime: { enabled: boolean; heartbeatSeconds: number };
  /** Rows a dashboard log window loads per page. */
  logPageSize: number;
  /**
   * Captures the screenshot gallery loads per page - its own setting, not logPageSize.
   *
   * A page of log rows is a few kilobytes of JSON; a page of screenshots is that many full-size
   * JPEGs the browser downloads and decodes, so the two cannot share a number.
   */
  screenshotPageSize: number;
  retention: { retentionDays: number; undeliveredRetentionDays: number };
  workingHours: { startLocal: string; endLocal: string; workingDays: string[] };
  categories: CategoryRow[];
}

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
}
