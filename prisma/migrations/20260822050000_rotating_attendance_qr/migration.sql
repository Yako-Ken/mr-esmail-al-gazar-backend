-- One-time use ledger for short-lived signed attendance QR tokens.
CREATE TABLE "AttendanceQrUse" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "jti" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "usedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AttendanceQrUse_jti_key" ON "AttendanceQrUse"("jti");
CREATE INDEX "AttendanceQrUse_expiresAt_idx" ON "AttendanceQrUse"("expiresAt");
CREATE INDEX "AttendanceQrUse_studentId_sessionId_idx" ON "AttendanceQrUse"("studentId", "sessionId");
