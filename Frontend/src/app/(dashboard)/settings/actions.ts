'use server';

import { revalidatePath } from 'next/cache';
import { apiSend } from '@/lib/api-client';
import type { CategoryTarget, ProductivityTag } from '@/types/api';

/**
 * Policy and category mutations (Features.md "Configuring Policies").
 *
 * Every write here bumps the policy version server-side, which is what makes agents pick the
 * change up on their next heartbeat and re-prompt the employee for acknowledgement.
 */

export interface PolicyFormValues {
  // -- What the agent collects on employee machines -------------------------
  attendanceEnabled: boolean;
  activityEnabled: boolean;
  idleThresholdSeconds: number;
  appSessionEnabled: boolean;
  browserMonitorEnabled: boolean;
  screenshotEnabled: boolean;
  screenshotIntervalSeconds: number;
  /** JPEG quality of a capture, 10-100. Trades file size and storage against legibility. */
  screenshotJpegQuality: number;
  usbEnabled: boolean;
  usbAlertOnInsertion: boolean;
  alertEnabled: boolean;
  alertIdleEnabled: boolean;
  alertIdleNormalSeconds: number;
  alertIdleModerateSeconds: number;
  alertIdleSevereSeconds: number;
  alertBlacklistEnabled: boolean;
  alertOutsideWorkingHours: boolean;
  workingHoursStartLocal: string;
  workingHoursEndLocal: string;

  // -- How the dashboard views it -------------------------------------------
  // Read-path only. Nothing here changes what is collected or reaches an agent.
  logPageSize: number;
  screenshotPageSize: number;

  // -- Advanced: fleet scale and data lifetime ------------------------------
  // The levers that decide what the server costs under load and how long records survive.
  // Configured here rather than in code because the right value depends on fleet size and on
  // the retention the business has committed to, neither of which waits for a deploy.
  retentionDays: number;
  syncBatchIntervalSeconds: number;
  syncMaxBatchSize: number;
  realtimeEnabled: boolean;
  presenceHeartbeatSeconds: number;
}

export async function updatePolicy(organizationId: string, values: PolicyFormValues) {
  await apiSend(`/v1/dashboard/organizations/${organizationId}/policy`, 'PATCH', values);
  revalidatePath('/settings');
}

export async function upsertCategory(
  organizationId: string,
  rule: { pattern: string; target: CategoryTarget; tag: ProductivityTag; isBlacklisted: boolean }
) {
  await apiSend(`/v1/dashboard/organizations/${organizationId}/categories`, 'PUT', rule);
  revalidatePath('/settings');
}

export async function deleteCategory(organizationId: string, categoryId: string) {
  await apiSend(`/v1/dashboard/organizations/${organizationId}/categories/${categoryId}`, 'DELETE');
  revalidatePath('/settings');
}
