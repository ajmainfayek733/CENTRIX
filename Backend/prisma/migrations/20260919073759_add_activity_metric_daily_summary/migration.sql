-- CreateTable
CREATE TABLE "activity_metric_daily_summaries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "keyCount" INTEGER NOT NULL DEFAULT 0,
    "mouseCount" INTEGER NOT NULL DEFAULT 0,
    "mouseLeftKeyCount" INTEGER NOT NULL DEFAULT 0,
    "mouseRightKeyCount" INTEGER NOT NULL DEFAULT 0,
    "mouseMiddleKeyCount" INTEGER NOT NULL DEFAULT 0,
    "mouseOtherKeyCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activity_metric_daily_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_metric_daily_summaries_employeeId_workDate_idx" ON "activity_metric_daily_summaries"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "activity_metric_daily_summaries_organizationId_workDate_idx" ON "activity_metric_daily_summaries"("organizationId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "activity_metric_daily_summaries_workDate_employeeId_key" ON "activity_metric_daily_summaries"("workDate", "employeeId");

-- AddForeignKey
ALTER TABLE "activity_metric_daily_summaries" ADD CONSTRAINT "activity_metric_daily_summaries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_metric_daily_summaries" ADD CONSTRAINT "activity_metric_daily_summaries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
