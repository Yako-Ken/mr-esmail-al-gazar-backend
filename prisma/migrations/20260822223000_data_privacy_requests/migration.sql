-- CreateTable
CREATE TABLE "DataPrivacyRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestKey" TEXT,
    "reason" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" DATETIME,
    "completedAt" DATETIME,
    "canceledAt" DATETIME,
    CONSTRAINT "DataPrivacyRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DataPrivacyRequest_requestKey_key" ON "DataPrivacyRequest"("requestKey");

-- CreateIndex
CREATE INDEX "DataPrivacyRequest_userId_type_requestedAt_idx" ON "DataPrivacyRequest"("userId", "type", "requestedAt");

-- CreateIndex
CREATE INDEX "DataPrivacyRequest_status_scheduledFor_idx" ON "DataPrivacyRequest"("status", "scheduledFor");
