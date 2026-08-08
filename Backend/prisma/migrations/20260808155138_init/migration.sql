-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('Application', 'Desktop', 'Locked', 'Idle', 'Sleeping', 'Disconnected');

-- CreateEnum
CREATE TYPE "ActivityEndReason" AS ENUM ('UserInactivity', 'ScreenLock', 'Sleep', 'Disconnect', 'AppSwitch', 'SessionEnd');

-- CreateEnum
CREATE TYPE "ProductivityTag" AS ENUM ('Productive', 'Unproductive', 'Blacklisted', 'Neutral');

-- CreateEnum
CREATE TYPE "SessionEndReason" AS ENUM ('Logout', 'Lock', 'Shutdown', 'Restart', 'Hibernate', 'Sleep', 'PowerLoss', 'Disconnect', 'Recovered');

-- CreateEnum
CREATE TYPE "UsbEventType" AS ENUM ('Connected', 'Disconnected');

-- CreateEnum
CREATE TYPE "UsbDeviceType" AS ENUM ('UsbStorage', 'MobileDevice', 'Hid', 'Other');

-- CreateEnum
CREATE TYPE "BrowserKind" AS ENUM ('Chrome', 'Edge', 'Firefox', 'Brave', 'Opera', 'Vivaldi', 'Other');

-- CreateEnum
CREATE TYPE "UrlProtocol" AS ENUM ('Http', 'Https');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('Information', 'Warning', 'High', 'Critical');

-- CreateEnum
CREATE TYPE "AlertState" AS ENUM ('New', 'Shown', 'Acknowledged', 'Resolved', 'Archived');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('IdleThreshold', 'BlacklistedApp', 'BlacklistedWebsite', 'UsbDeviceConnected');

-- CreateEnum
CREATE TYPE "CategoryTarget" AS ENUM ('Application', 'Domain');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('super_admin', 'manager', 'auditor');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enrollmentTokenHash" TEXT,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "department" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "systemType" TEXT,
    "edition" TEXT,
    "version" TEXT,
    "macAddress" TEXT,
    "agentVersion" TEXT,
    "apiKeyHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeen" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_sessions" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userSid" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "loginTime" TIMESTAMP(3) NOT NULL,
    "logoutTime" TIMESTAMP(3),
    "endReason" "SessionEndReason",
    "workDate" DATE NOT NULL,
    "totalActiveSeconds" INTEGER NOT NULL DEFAULT 0,
    "totalIdleSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_metrics" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "clientEventId" TEXT NOT NULL,
    "keyCount" INTEGER NOT NULL DEFAULT 0,
    "mouseCount" INTEGER NOT NULL DEFAULT 0,
    "mouseLeftKeyCount" INTEGER NOT NULL DEFAULT 0,
    "mouseRightKeyCount" INTEGER NOT NULL DEFAULT 0,
    "mouseMiddleKeyCount" INTEGER NOT NULL DEFAULT 0,
    "mouseOtherKeyCount" INTEGER NOT NULL DEFAULT 0,
    "windowStartUtc" TIMESTAMP(3) NOT NULL,
    "windowEndUtc" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_sessions" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "activitySessionId" TEXT NOT NULL,
    "appName" TEXT,
    "processName" TEXT,
    "executablePath" TEXT,
    "type" "ActivityType" NOT NULL,
    "windowTitle" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "reason" "ActivityEndReason",
    "productivityTag" "ProductivityTag" NOT NULL DEFAULT 'Neutral',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_activity" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "browserActivityId" TEXT NOT NULL,
    "activitySessionId" TEXT,
    "browser" "BrowserKind" NOT NULL,
    "browserVersion" TEXT,
    "profileName" TEXT,
    "domain" TEXT NOT NULL,
    "rawUrl" TEXT NOT NULL,
    "windowTitle" TEXT,
    "pageTitle" TEXT,
    "protocol" "UrlProtocol" NOT NULL DEFAULT 'Https',
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "productivityTag" "ProductivityTag" NOT NULL DEFAULT 'Neutral',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "browser_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usb_events" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sessionId" TEXT,
    "clientEventId" TEXT NOT NULL,
    "eventType" "UsbEventType" NOT NULL,
    "deviceType" "UsbDeviceType" NOT NULL,
    "friendlyName" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "vendorId" TEXT,
    "productId" TEXT,
    "driveLetter" TEXT,
    "volumeLabel" TEXT,
    "capacityBytes" BIGINT,
    "fileSystem" TEXT,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usb_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "clientEventId" TEXT NOT NULL,
    "userSid" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "state" "AlertState" NOT NULL DEFAULT 'New',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "idleSeconds" INTEGER,
    "thresholdSeconds" INTEGER,
    "contextAppName" TEXT,
    "contextProcessName" TEXT,
    "contextDomain" TEXT,
    "contextUrl" TEXT,
    "contextUsbSerialNumber" TEXT,
    "contextUsbFriendlyName" TEXT,
    "triggeredAt" TIMESTAMP(3) NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "notificationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screenshots" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "clientEventId" TEXT NOT NULL,
    "userSid" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screenshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "attendanceEnabled" BOOLEAN NOT NULL DEFAULT true,
    "activityEnabled" BOOLEAN NOT NULL DEFAULT true,
    "idleThresholdSeconds" INTEGER NOT NULL DEFAULT 300,
    "appSessionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "appSessionPollSeconds" INTEGER NOT NULL DEFAULT 1,
    "browserMonitorEnabled" BOOLEAN NOT NULL DEFAULT true,
    "browserUiaTimeoutMs" INTEGER NOT NULL DEFAULT 500,
    "browserMaxRetryAttempts" INTEGER NOT NULL DEFAULT 3,
    "screenshotEnabled" BOOLEAN NOT NULL DEFAULT true,
    "screenshotIntervalSeconds" INTEGER NOT NULL DEFAULT 600,
    "screenshotJpegQuality" INTEGER NOT NULL DEFAULT 70,
    "usbEnabled" BOOLEAN NOT NULL DEFAULT true,
    "usbReconciliationIntervalSeconds" INTEGER NOT NULL DEFAULT 5,
    "usbAlertOnInsertion" BOOLEAN NOT NULL DEFAULT false,
    "alertEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertIdleEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertIdleNormalSeconds" INTEGER NOT NULL DEFAULT 1800,
    "alertIdleModerateSeconds" INTEGER NOT NULL DEFAULT 2700,
    "alertIdleSevereSeconds" INTEGER NOT NULL DEFAULT 3600,
    "alertIdleRenotifySeconds" INTEGER NOT NULL DEFAULT 900,
    "alertBlacklistEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertOutsideWorkingHours" BOOLEAN NOT NULL DEFAULT false,
    "syncBatchIntervalSeconds" INTEGER NOT NULL DEFAULT 120,
    "syncMaxBatchSize" INTEGER NOT NULL DEFAULT 500,
    "syncMinRetryBackoffSeconds" INTEGER NOT NULL DEFAULT 5,
    "syncMaxRetryBackoffSeconds" INTEGER NOT NULL DEFAULT 120,
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "undeliveredRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "workingHoursStartLocal" TEXT NOT NULL DEFAULT '08:00',
    "workingHoursEndLocal" TEXT NOT NULL DEFAULT '17:00',
    "workingDays" TEXT[] DEFAULT ARRAY['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "target" "CategoryTarget" NOT NULL,
    "tag" "ProductivityTag" NOT NULL,
    "isBlacklisted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userSid" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'manager',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "idToken" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_enrollmentTokenHash_key" ON "organizations"("enrollmentTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "employees_email_key" ON "employees"("email");

-- CreateIndex
CREATE INDEX "employees_organizationId_idx" ON "employees"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "devices_deviceId_key" ON "devices"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "devices_apiKeyHash_key" ON "devices"("apiKeyHash");

-- CreateIndex
CREATE INDEX "devices_organizationId_idx" ON "devices"("organizationId");

-- CreateIndex
CREATE INDEX "devices_employeeId_idx" ON "devices"("employeeId");

-- CreateIndex
CREATE INDEX "devices_macAddress_idx" ON "devices"("macAddress");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_sessions_sessionId_key" ON "attendance_sessions"("sessionId");

-- CreateIndex
CREATE INDEX "attendance_sessions_deviceId_workDate_idx" ON "attendance_sessions"("deviceId", "workDate");

-- CreateIndex
CREATE INDEX "attendance_sessions_userSid_workDate_idx" ON "attendance_sessions"("userSid", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "activity_metrics_clientEventId_key" ON "activity_metrics"("clientEventId");

-- CreateIndex
CREATE INDEX "activity_metrics_deviceId_windowEndUtc_idx" ON "activity_metrics"("deviceId", "windowEndUtc");

-- CreateIndex
CREATE INDEX "activity_metrics_sessionId_idx" ON "activity_metrics"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_sessions_activitySessionId_key" ON "activity_sessions"("activitySessionId");

-- CreateIndex
CREATE INDEX "activity_sessions_deviceId_startTime_idx" ON "activity_sessions"("deviceId", "startTime");

-- CreateIndex
CREATE INDEX "activity_sessions_sessionId_startTime_idx" ON "activity_sessions"("sessionId", "startTime");

-- CreateIndex
CREATE INDEX "activity_sessions_deviceId_productivityTag_idx" ON "activity_sessions"("deviceId", "productivityTag");

-- CreateIndex
CREATE UNIQUE INDEX "browser_activity_browserActivityId_key" ON "browser_activity"("browserActivityId");

-- CreateIndex
CREATE INDEX "browser_activity_deviceId_startTime_idx" ON "browser_activity"("deviceId", "startTime");

-- CreateIndex
CREATE INDEX "browser_activity_domain_idx" ON "browser_activity"("domain");

-- CreateIndex
CREATE INDEX "browser_activity_activitySessionId_idx" ON "browser_activity"("activitySessionId");

-- CreateIndex
CREATE UNIQUE INDEX "usb_events_clientEventId_key" ON "usb_events"("clientEventId");

-- CreateIndex
CREATE INDEX "usb_events_deviceId_eventTime_idx" ON "usb_events"("deviceId", "eventTime");

-- CreateIndex
CREATE INDEX "usb_events_serialNumber_idx" ON "usb_events"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_clientEventId_key" ON "alerts"("clientEventId");

-- CreateIndex
CREATE INDEX "alerts_deviceId_triggeredAt_idx" ON "alerts"("deviceId", "triggeredAt");

-- CreateIndex
CREATE INDEX "alerts_userSid_type_resolvedAt_idx" ON "alerts"("userSid", "type", "resolvedAt");

-- CreateIndex
CREATE INDEX "alerts_severity_state_idx" ON "alerts"("severity", "state");

-- CreateIndex
CREATE UNIQUE INDEX "screenshots_clientEventId_key" ON "screenshots"("clientEventId");

-- CreateIndex
CREATE INDEX "screenshots_deviceId_capturedAt_idx" ON "screenshots"("deviceId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "policies_organizationId_key" ON "policies"("organizationId");

-- CreateIndex
CREATE INDEX "categories_organizationId_target_idx" ON "categories"("organizationId", "target");

-- CreateIndex
CREATE UNIQUE INDEX "categories_organizationId_target_pattern_key" ON "categories"("organizationId", "target", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "consent_records_deviceId_userSid_policyVersion_key" ON "consent_records"("deviceId", "userSid", "policyVersion");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "audit_logs_userId_timestamp_idx" ON "audit_logs"("userId", "timestamp");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_metrics" ADD CONSTRAINT "activity_metrics_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_metrics" ADD CONSTRAINT "activity_metrics_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "attendance_sessions"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "attendance_sessions"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_activity" ADD CONSTRAINT "browser_activity_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_activity" ADD CONSTRAINT "browser_activity_activitySessionId_fkey" FOREIGN KEY ("activitySessionId") REFERENCES "activity_sessions"("activitySessionId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usb_events" ADD CONSTRAINT "usb_events_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usb_events" ADD CONSTRAINT "usb_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "attendance_sessions"("sessionId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
