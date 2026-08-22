-- AlterTable
ALTER TABLE "DataPrivacyRequest" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DataPrivacyRequest" ADD COLUMN "lastError" TEXT;
