-- CreateEnum
CREATE TYPE "LogoutSource" AS ENUM ('Agent', 'Server');

-- AlterTable
ALTER TABLE "attendance_sessions" ADD COLUMN     "logoutSource" "LogoutSource";

-- CreateIndex
CREATE INDEX "attendance_sessions_logoutTime_loginTime_idx" ON "attendance_sessions"("logoutTime", "loginTime");

-- CreateIndex
CREATE INDEX "attendance_sessions_deviceId_userSid_loginTime_idx" ON "attendance_sessions"("deviceId", "userSid", "loginTime");
