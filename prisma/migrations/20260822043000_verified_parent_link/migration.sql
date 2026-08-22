-- Verified, expiring parent/student linking requests. Phone hints alone never authorize access.
CREATE TABLE "ParentLinkRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "studentId" TEXT NOT NULL,
  "studentPhone" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "parentId" TEXT,
  "expiresAt" DATETIME NOT NULL,
  "consumedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "ParentLinkRequest_studentId_status_createdAt_idx" ON "ParentLinkRequest"("studentId", "status", "createdAt");
CREATE INDEX "ParentLinkRequest_studentPhone_status_idx" ON "ParentLinkRequest"("studentPhone", "status");
