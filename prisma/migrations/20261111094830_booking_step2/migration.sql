-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "seats" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "signaturePng" BYTEA;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "requireSignature" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "upsellVariantIds" JSONB;

-- AlterTable
ALTER TABLE "SlotHold" ADD COLUMN     "intakeAnswers" JSONB,
ADD COLUMN     "seats" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "signaturePng" BYTEA;
