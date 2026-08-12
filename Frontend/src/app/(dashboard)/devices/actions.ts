'use server';

import { revalidatePath } from 'next/cache';
import { apiSend } from '@/lib/api-client';

/**
 * Device mutations, as server actions.
 *
 * Server actions rather than client fetches to the API: the session token lives in an httpOnly
 * cookie that only server code can read, and this keeps the rule from Docs/Frontend/NextJS.md
 * section 6 - no component ever calls the monitoring API directly with its own credentials.
 *
 * The backend re-checks super_admin on both of these routes, so this is not the security
 * boundary; it is the mechanism.
 */

export async function setDeviceActive(deviceId: string, isActive: boolean) {
  await apiSend(`/v1/dashboard/employees/devices/${deviceId}/status`, 'PATCH', { isActive });
  revalidatePath('/devices');
}

export async function assignDevice(deviceId: string, employeeId: string) {
  await apiSend(`/v1/dashboard/employees/devices/${deviceId}/assignment`, 'PATCH', { employeeId });
  revalidatePath('/devices');
}
