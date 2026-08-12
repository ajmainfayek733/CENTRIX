-- AlterTable
ALTER TABLE "policies" ADD COLUMN     "logPageSize" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "realtimeEnabled" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "syncMaxBatchSize" SET DEFAULT 100;

-- CreateTable
CREATE TABLE "ingest_batches" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "eventIdsHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingest_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_activity_rollups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "activeSeconds" INTEGER NOT NULL DEFAULT 0,
    "idleSeconds" INTEGER NOT NULL DEFAULT 0,
    "productiveSeconds" INTEGER NOT NULL DEFAULT 0,
    "unproductiveSeconds" INTEGER NOT NULL DEFAULT 0,
    "neutralSeconds" INTEGER NOT NULL DEFAULT 0,
    "blacklistedSeconds" INTEGER NOT NULL DEFAULT 0,
    "keyCount" INTEGER NOT NULL DEFAULT 0,
    "mouseCount" INTEGER NOT NULL DEFAULT 0,
    "activitySessionCount" INTEGER NOT NULL DEFAULT 0,
    "browserVisitCount" INTEGER NOT NULL DEFAULT 0,
    "usbEventCount" INTEGER NOT NULL DEFAULT 0,
    "alertCount" INTEGER NOT NULL DEFAULT 0,
    "firstActivityAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_activity_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingest_batches_receivedAt_idx" ON "ingest_batches"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ingest_batches_deviceId_batchId_key" ON "ingest_batches"("deviceId", "batchId");

-- CreateIndex
CREATE INDEX "daily_activity_rollups_employeeId_workDate_idx" ON "daily_activity_rollups"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "daily_activity_rollups_organizationId_workDate_idx" ON "daily_activity_rollups"("organizationId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "daily_activity_rollups_workDate_deviceId_employeeId_key" ON "daily_activity_rollups"("workDate", "deviceId", "employeeId");

-- AddForeignKey
ALTER TABLE "ingest_batches" ADD CONSTRAINT "ingest_batches_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_activity_rollups" ADD CONSTRAINT "daily_activity_rollups_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_activity_rollups" ADD CONSTRAINT "daily_activity_rollups_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_activity_rollups" ADD CONSTRAINT "daily_activity_rollups_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
