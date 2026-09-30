"use client";

import type { AttendanceDay } from "@/types/api";
import { AttendanceDaysTable, AttendanceSessionsTable, type AttendanceSession } from "./Attendance";

export interface AttendanceProps {
  attendanceInitial: AttendanceDay[];
  attendanceSessionsInitial: AttendanceSession[];
}

export function AttendanceProvider({
  attendanceInitial,
  attendanceSessionsInitial,
}: AttendanceProps) {
  return (
    <div className="sm:space-y-10 space-y-6">
      <AttendanceDaysTable days={attendanceInitial} />
      <AttendanceSessionsTable sessions={attendanceSessionsInitial} />
    </div>
  );
}
