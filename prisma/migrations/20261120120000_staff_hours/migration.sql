-- Staff: own working hours and days off.
ALTER TABLE "Staff" ADD COLUMN "hours" JSONB,
ADD COLUMN "daysOff" JSONB;
