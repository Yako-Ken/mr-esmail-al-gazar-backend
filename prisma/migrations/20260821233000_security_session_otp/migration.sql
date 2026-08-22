-- Security hardening: reset-password attempts and global session revocation.
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PasswordResetOTP" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PasswordResetOTP" ADD COLUMN "consumedAt" DATETIME;
