-- Staff (people/resources customers can book) and combined services.

-- CreateEnum
CREATE TYPE "StaffMode" AS ENUM ('NONE', 'OPTIONAL', 'REQUIRED');

-- AlterTable
ALTER TABLE "Service" ADD COLUMN "staffMode" "StaffMode" NOT NULL DEFAULT 'NONE',
ADD COLUMN "comboServiceIds" JSONB;

-- AlterTable
ALTER TABLE "SlotHold" ADD COLUMN "staffId" TEXT;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "staffId" TEXT;

-- CreateTable
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceStaff" (
    "serviceId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,

    CONSTRAINT "ServiceStaff_pkey" PRIMARY KEY ("serviceId","staffId")
);

-- CreateIndex
CREATE INDEX "Staff_shopId_sortOrder_idx" ON "Staff"("shopId", "sortOrder");

-- CreateIndex
CREATE INDEX "ServiceStaff_staffId_idx" ON "ServiceStaff"("staffId");

-- CreateIndex
CREATE INDEX "SlotHold_staffId_startsAt_idx" ON "SlotHold"("staffId", "startsAt");

-- CreateIndex
CREATE INDEX "Booking_staffId_startsAt_idx" ON "Booking"("staffId", "startsAt");

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceStaff" ADD CONSTRAINT "ServiceStaff_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceStaff" ADD CONSTRAINT "ServiceStaff_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotHold" ADD CONSTRAINT "SlotHold_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
