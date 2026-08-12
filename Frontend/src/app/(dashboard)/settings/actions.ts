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
  attendanceEnabled: boolean;
  activityEnabled: boolean;
  idleThresholdSeconds: number;
  appSessionEnabled: boolean;
  browserMonitorEnabled: boolean;
  screenshotEnabled: boolean;
  screenshotIntervalSeconds: number;
  usbEnabled: boolean;
  usbAlertOnInsertion: boolean;
  alertEnabled: boolean;
  alertIdleEnabled: boolean;
  alertIdleNormalSeconds: number;
  alertIdleModerateSeconds: number;
  alertIdleSevereSeconds: number;
  alertBlacklistEnabled: boolean;
  alertOutsideWorkingHours: boolean;
  retentionDays: number;
  workingHoursStartLocal: string;
  workingHoursEndLocal: string;

  // -- Sync and scale -------------------------------------------------------
  // The levers that decide what the server costs under load. Configured here rather than in
  // code because the right value depends on fleet size, which changes without a deploy.
  syncBatchIntervalSeconds: number;
  syncMaxBatchSize: number;
  logPageSize: number;
  realtimeEnabled: boolean;
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
