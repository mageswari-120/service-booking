-- New services can be booked up to a year ahead by default (was 60 days).
ALTER TABLE "Service" ALTER COLUMN "maxAdvanceDays" SET DEFAULT 365;
