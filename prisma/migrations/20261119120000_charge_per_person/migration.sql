-- Per-service pricing: per person (cart quantity = party size) or per booking.
ALTER TABLE "Service" ADD COLUMN "chargePerPerson" BOOLEAN NOT NULL DEFAULT false;
