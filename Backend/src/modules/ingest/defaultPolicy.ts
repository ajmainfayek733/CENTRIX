/**
 * Mirrors Agent.Core.Policy.PolicyDocument's per-field defaults exactly (see
 * `Windows Software/src/Agent.Core/Policy/*.cs`), formatted the way .NET's built-in
 * System.Text.Json TimeSpan/TimeOnly converters emit them, and using the field casing shown in
 * docs/backend-api-specification.md §4.2 (the client deserializes case-insensitively, so this
 * casing is a documentation choice, not a strict requirement).
 *
 * This is the seed used for a new organization's Policy row (version 1) and the fallback
 * returned if a device's organization somehow has none.
 */
export const DEFAULT_POLICY_DOCUMENT = {
  Attendance: {
    Enabled: true,
    IdleThreshold: "00:05:00",
  },
  Activity: {
    Enabled: true,
    IdleThreshold: "00:05:00",
    MeetingDetectionEnabled: true,
    MeetingOrPresentationFlagAfter: "00:40:00",
    MeetingProcessNames: ["Teams", "Zoom", "slack", "GoogleMeet", "lync"],
    PresentationProcessNames: ["POWERPNT", "wpp"],
    CpuBusyThresholdPercent: 50.0,
  },
  AppSession: {
    Enabled: true,
    PollInterval: "00:00:01",
  },
  BrowserMonitor: {
    Enabled: true,
    UiaTimeout: "00:00:00.5000000",
    MaxRetryAttempts: 3,
  },
  Screenshot: {
    Enabled: true,
    CaptureInterval: "00:2:00",
    JpegQuality: 70,
  },
  Usb: {
    Enabled: true,
    ReconciliationInterval: "00:00:05",
    EventCorrelationWindow: "00:00:03",
    AlertOnInsertion: false,
  },
  Alert: {
    Enabled: true,
    Idle: {
      Enabled: true,
      WarningAfter: "01:00:00",
      HighAfter: "01:10:00",
      CriticalAfter: "01:20:00",
      NotifyManagerAfter: "01:30:00",
      RenotifyInterval: "00:15:00",
    },
    Blacklist: {
      Enabled: false,
      Categories: [] as string[],
      DomainPatterns: [] as string[],
    },
    NotifyOutsideWorkingHours: false,
  },
  Sync: {
    BatchInterval: "00:02:00",
    MaxBatchSize: 500,
    MinRetryBackoff: "00:00:05",
    MaxRetryBackoff: "00:02:00",
  },
  Retention: {
    UndeliveredRetentionDays: 30,
  },
  WorkingHours: {
    StartLocal: "08:00:00",
    EndLocal: "17:00:00",
    WorkingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as string[],
  },
  ProductivityTags: {} as Record<string, string>,
};

export type PolicyDocumentBody = typeof DEFAULT_POLICY_DOCUMENT;
