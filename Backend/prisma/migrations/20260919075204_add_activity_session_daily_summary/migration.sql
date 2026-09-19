-- CreateTable
CREATE TABLE "activity_session_daily_summaries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "appName" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "productiveSeconds" INTEGER NOT NULL DEFAULT 0,
    "unproductiveSeconds" INTEGER NOT NULL DEFAULT 0,
    "neutralSeconds" INTEGER NOT NULL DEFAULT 0,
    "blacklistedSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activity_session_daily_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_session_daily_summaries_employeeId_workDate_idx" ON "activity_session_daily_summaries"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "activity_session_daily_summaries_organizationId_workDate_idx" ON "activity_session_daily_summaries"("organizationId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "activity_session_daily_summaries_workDate_employeeId_appNam_key" ON "activity_session_daily_summaries"("workDate", "employeeId", "appName");

-- AddForeignKey
ALTER TABLE "activity_session_daily_summaries" ADD CONSTRAINT "activity_session_daily_summaries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_session_daily_summaries" ADD CONSTRAINT "activity_session_daily_summaries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
