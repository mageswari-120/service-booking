-- CreateEnum
CREATE TYPE "CapacityMode" AS ENUM ('PEOPLE', 'BOOKINGS');

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "capacityMode" "CapacityMode" NOT NULL DEFAULT 'PEOPLE',
ADD COLUMN     "maxSeatsPerBooking" INTEGER,
ADD COLUMN     "minSeatsPerBooking" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "AvailabilityRule" ADD COLUMN     "capacity" INTEGER;

-- CreateTable
CREATE TABLE "CapacityOverride" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "capacity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapacityOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CapacityOverride_serviceId_date_idx" ON "CapacityOverride"("serviceId", "date");

-- AddForeignKey
ALTER TABLE "CapacityOverride" ADD CONSTRAINT "CapacityOverride_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

