import { Policy } from '@prisma/client';
import { prisma } from '../../config/db';

/**
 * Policy is stored as one typed row per organization (see the Policy model). This module maps
 * that row to the wire shape the Agent consumes and back again.
 *
 * Contract note: `version` MUST increment on every write. The Agent compares the version it
 * holds against the one it fetches to decide whether to re-prompt for consent (spec §3), so a
 * silent update that leaves the version alone would skip that prompt.
 */

/** The document GET /api/v1/policy returns. Mirrors Agent.Core/Policy/AgentPolicy.cs. */
export interface AgentPolicyDto {
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
  /// Whether the agent should hold a Socket.IO signalling connection. It syncs on its own
  /// interval regardless — this only decides whether it also listens for a nudge.
  realtime: { enabled: boolean };
  /// Rows a dashboard log window loads per page. Served in the same document as everything else
  /// so the settings screen has one place to read and write policy; agents simply ignore it.
  logPageSize: number;
  retention: { retentionDays: number; undeliveredRetentionDays: number };
  workingHours: { startLocal: string; endLocal: string; workingDays: string[] };
  /// Blacklist and productivity rules, flattened from the categories table so the agent can
  /// raise a local notification without a round trip.
  categories: Array<{ pattern: string; target: 'Application' | 'Domain'; tag: string; isBlacklisted: boolean }>;
}

export function toAgentPolicy(
  policy: Policy,
  categories: AgentPolicyDto['categories']
): AgentPolicyDto {
  return {
    version: policy.version,
    attendance: { enabled: policy.attendanceEnabled },
    activity: {
      enabled: policy.activityEnabled,
      idleThresholdSeconds: policy.idleThresholdSeconds,
    },
    appSession: {
      enabled: policy.appSessionEnabled,
      pollSeconds: policy.appSessionPollSeconds,
    },
    browserMonitor: {
      enabled: policy.browserMonitorEnabled,
      uiaTimeoutMs: policy.browserUiaTimeoutMs,
      maxRetryAttempts: policy.browserMaxRetryAttempts,
    },
    screenshot: {
      enabled: policy.screenshotEnabled,
      intervalSeconds: policy.screenshotIntervalSeconds,
      jpegQuality: policy.screenshotJpegQuality,
    },
    usb: {
      enabled: policy.usbEnabled,
      reconciliationIntervalSeconds: policy.usbReconciliationIntervalSeconds,
      alertOnInsertion: policy.usbAlertOnInsertion,
    },
    alert: {
      enabled: policy.alertEnabled,
      idle: {
        enabled: policy.alertIdleEnabled,
        normalSeconds: policy.alertIdleNormalSeconds,
        moderateSeconds: policy.alertIdleModerateSeconds,
        severeSeconds: policy.alertIdleSevereSeconds,
        renotifySeconds: policy.alertIdleRenotifySeconds,
      },
      blacklistEnabled: policy.alertBlacklistEnabled,
      notifyOutsideWorkingHours: policy.alertOutsideWorkingHours,
    },
    sync: {
      batchIntervalSeconds: policy.syncBatchIntervalSeconds,
      maxBatchSize: policy.syncMaxBatchSize,
      minRetryBackoffSeconds: policy.syncMinRetryBackoffSeconds,
      maxRetryBackoffSeconds: policy.syncMaxRetryBackoffSeconds,
    },
    realtime: { enabled: policy.realtimeEnabled },
    logPageSize: policy.logPageSize,
    retention: {
      retentionDays: policy.retentionDays,
      undeliveredRetentionDays: policy.undeliveredRetentionDays,
    },
    workingHours: {
      startLocal: policy.workingHoursStartLocal,
      endLocal: policy.workingHoursEndLocal,
      workingDays: policy.workingDays,
    },
    categories,
  };
}

/**
 * Returns the org's policy, creating the default row on first read. Every column has a
 * database-level default matching Features.md, so an empty `create` seeds a complete policy.
 */
export async function getOrCreatePolicy(organizationId: string): Promise<AgentPolicyDto> {
  const [policy, categories] = await Promise.all([
    prisma.policy.upsert({
      where: { organizationId },
      create: { organizationId },
      update: {},
    }),
    prisma.category.findMany({
      where: { organizationId },
      select: { pattern: true, target: true, tag: true, isBlacklisted: true },
      orderBy: { pattern: 'asc' },
    }),
  ]);

  return toAgentPolicy(policy, categories);
}
