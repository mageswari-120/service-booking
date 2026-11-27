-- Booking: the customer's own timezone (storefront `_booking_tz`), for their emails.
ALTER TABLE "Booking" ADD COLUMN "customerTimezone" TEXT;
