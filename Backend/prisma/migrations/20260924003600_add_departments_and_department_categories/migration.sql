-- CreateTable
CREATE TABLE IF NOT EXISTS "departments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "departments_organizationId_name_key" ON "departments"("organizationId", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "departments_organizationId_idx" ON "departments"("organizationId");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "departmentId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "employees_departmentId_idx" ON "employees"("departmentId");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "departmentId" TEXT;

-- DropIndex (if exists)
DROP INDEX IF EXISTS "categories_organizationId_target_pattern_key";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "categories_organizationId_departmentId_target_pattern_key" ON "categories"("organizationId", "departmentId", "target", "pattern");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "categories_departmentId_idx" ON "categories"("departmentId");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

