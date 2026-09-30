"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api-client";
import type { CategoryTarget, ProductivityTag } from "@/types/api";

export async function createDepartment(
  organizationId: string,
  data: { name: string; description?: string },
) {
  const res = await apiSend(
    `/v1/dashboard/organizations/${organizationId}/departments`,
    "POST",
    data,
  );
  revalidatePath("/departments");
  revalidatePath("/settings");
  revalidatePath("/reports");
  return res;
}

export async function deleteDepartment(organizationId: string, departmentId: string) {
  const res = await apiSend(
    `/v1/dashboard/organizations/${organizationId}/departments/${departmentId}`,
    "DELETE",
  );
  revalidatePath("/departments");
  revalidatePath("/settings");
  revalidatePath("/reports");
  return res;
}

export async function addDepartmentMembers(
  organizationId: string,
  departmentId: string,
  employeeIds: string[],
) {
  const res = await apiSend(
    `/v1/dashboard/organizations/${organizationId}/departments/${departmentId}/members`,
    "POST",
    { employeeIds },
  );
  revalidatePath("/departments");
  revalidatePath("/employees");
  revalidatePath("/reports");
  return res;
}

export async function removeDepartmentMember(
  organizationId: string,
  departmentId: string,
  employeeId: string,
) {
  const res = await apiSend(
    `/v1/dashboard/organizations/${organizationId}/departments/${departmentId}/members/${employeeId}`,
    "DELETE",
  );
  revalidatePath("/departments");
  revalidatePath("/employees");
  revalidatePath("/reports");
  return res;
}

export async function upsertDepartmentCategory(
  organizationId: string,
  departmentId: string,
  rule: {
    pattern: string;
    target: CategoryTarget;
    tag: ProductivityTag;
    isBlacklisted: boolean;
  },
) {
  const res = await apiSend(
    `/v1/dashboard/organizations/${organizationId}/departments/${departmentId}/categories`,
    "POST",
    rule,
  );
  revalidatePath("/departments");
  revalidatePath("/settings");
  return res;
}

export async function deleteDepartmentCategory(
  organizationId: string,
  departmentId: string,
  categoryId: string,
) {
  const res = await apiSend(
    `/v1/dashboard/organizations/${organizationId}/departments/${departmentId}/categories/${categoryId}`,
    "DELETE",
  );
  revalidatePath("/departments");
  revalidatePath("/settings");
  return res;
}
