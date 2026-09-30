'use server';

import { revalidatePath } from 'next/cache';
import { apiSend } from '@/lib/api-client';

/**
 * Roster mutations, as server actions - same rule as the devices screen: no client component
 * ever calls the monitoring API directly, because the session token lives in an httpOnly cookie
 * only server code can read.
 */

export interface ImportRow {
  name: string;
  email: string;
  /** Authoritative reference, picked from the departments fetched from the backend. */
  departmentId?: string;
  /** Plain department name (paste import); matched to an existing department server-side. */
  department?: string;
}

export interface ImportResult {
  submitted: number;
  created: number;
  skipped: number;
  /** Created employees that ended up without a department. */
  unassigned: number;
  results: Array<{
    email: string;
    status: 'created' | 'skipped';
    reason?: string;
    warning?: string;
  }>;
}

export async function importEmployees(organizationId: string, employees: ImportRow[]) {
  const result = await apiSend<ImportResult>('/v1/dashboard/employees/bulk', 'POST', {
    organizationId,
    employees,
  });

  // Both screens change: the roster gains people, and the devices screen gains assignment
  // targets it could not offer before.
  revalidatePath('/employees');
  revalidatePath('/devices');

  return result;
}
