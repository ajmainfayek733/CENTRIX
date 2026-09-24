import { NextResponse, type NextRequest } from "next/server";
import { serverFetch, ApiUnavailableError } from "@/lib/api-client";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ departmentId: string }> },
) {
  const { departmentId } = await context.params;

  if (!departmentId || !/^[A-Za-z0-9_-]{1,128}$/.test(departmentId)) {
    return NextResponse.json({ error: "Invalid department ID" }, { status: 400 });
  }

  const incoming = request.nextUrl.searchParams;
  const forwarded = new URLSearchParams();
  if (incoming.get("startDate")) forwarded.set("startDate", incoming.get("startDate")!);
  if (incoming.get("endDate")) forwarded.set("endDate", incoming.get("endDate")!);

  const query = forwarded.toString();
  const upstreamPath = `/v1/dashboard/reports/departments/${encodeURIComponent(departmentId)}/batch-zip${query ? `?${query}` : ""}`;

  try {
    const upstreamRes = await serverFetch(upstreamPath);

    if (!upstreamRes.ok) {
      const errorText = await upstreamRes.text();
      return NextResponse.json(
        { error: errorText || "Failed to generate department batch ZIP bundle" },
        { status: upstreamRes.status },
      );
    }

    const contentType = upstreamRes.headers.get("content-type") || "application/zip";
    const contentDisposition =
      upstreamRes.headers.get("content-disposition") ||
      `attachment; filename="department_bundle_${departmentId}.zip"`;

    return new Response(upstreamRes.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": contentDisposition,
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
      },
    });
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      console.error("reports/departments/batch-zip: monitoring service unreachable:", error);
      return NextResponse.json(
        { error: "The monitoring service is currently unavailable" },
        { status: 503 },
      );
    }

    console.error("reports/departments/batch-zip: request failed:", error);
    return NextResponse.json(
      { error: "Unable to generate department batch ZIP bundle" },
      { status: 500 },
    );
  }
}
