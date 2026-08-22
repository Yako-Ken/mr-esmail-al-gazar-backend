CREATE TABLE "UserSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "deviceName" TEXT NOT NULL,
  "userAgent" TEXT,
  "ipHint" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "revokedAt" DATETIME,
  CONSTRAINT "UserSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "UserSession_userId_revokedAt_expiresAt_idx"
  ON "UserSession"("userId", "revokedAt", "expiresAt");
