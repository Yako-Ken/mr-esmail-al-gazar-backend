-- Integer-money commerce foundation. Legacy Course.price remains temporarily for backward compatibility.
ALTER TABLE "Course" ADD COLUMN "priceMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Course" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'EGP';
UPDATE "Course" SET "priceMinor" = CAST(ROUND("price" * 100) AS INTEGER);

CREATE TABLE "PaymentOrder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "studentId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EGP',
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" TEXT NOT NULL,
  "providerOrderId" TEXT,
  "providerIntentionId" TEXT,
  "checkoutUrl" TEXT,
  "failureReason" TEXT,
  "paidAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PaymentOrder_idempotencyKey_key" ON "PaymentOrder"("idempotencyKey");
CREATE UNIQUE INDEX "PaymentOrder_providerOrderId_key" ON "PaymentOrder"("providerOrderId");
CREATE UNIQUE INDEX "PaymentOrder_providerIntentionId_key" ON "PaymentOrder"("providerIntentionId");
CREATE INDEX "PaymentOrder_studentId_createdAt_idx" ON "PaymentOrder"("studentId", "createdAt");
CREATE INDEX "PaymentOrder_courseId_status_idx" ON "PaymentOrder"("courseId", "status");

CREATE TABLE "PaymentAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "paymentOrderId" TEXT NOT NULL,
  "providerAttemptId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'CREATED',
  "responseCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PaymentAttempt_providerAttemptId_key" ON "PaymentAttempt"("providerAttemptId");
CREATE INDEX "PaymentAttempt_paymentOrderId_createdAt_idx" ON "PaymentAttempt"("paymentOrderId", "createdAt");

CREATE TABLE "PaymentEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "externalEventId" TEXT NOT NULL,
  "paymentOrderId" TEXT,
  "eventType" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "processingStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" DATETIME
);
CREATE UNIQUE INDEX "PaymentEvent_externalEventId_key" ON "PaymentEvent"("externalEventId");
CREATE INDEX "PaymentEvent_paymentOrderId_createdAt_idx" ON "PaymentEvent"("paymentOrderId", "createdAt");

CREATE TABLE "CourseEntitlement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "studentId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "sourceOrderId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" DATETIME,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "CourseEntitlement_studentId_courseId_key" ON "CourseEntitlement"("studentId", "courseId");
CREATE INDEX "CourseEntitlement_sourceOrderId_idx" ON "CourseEntitlement"("sourceOrderId");

CREATE TABLE "Refund" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "paymentOrderId" TEXT NOT NULL,
  "providerRefundId" TEXT,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EGP',
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "reason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Refund_providerRefundId_key" ON "Refund"("providerRefundId");
CREATE INDEX "Refund_paymentOrderId_createdAt_idx" ON "Refund"("paymentOrderId", "createdAt");
