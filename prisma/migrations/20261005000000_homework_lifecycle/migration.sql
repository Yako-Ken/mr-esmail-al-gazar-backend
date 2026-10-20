-- Homework lifecycle, approved for the first release.
--
--   NOT_SUBMITTED → SUBMITTED → UNDER_REVIEW → GRADED
--   teacher may return for revision (NEEDS_REVISION) → student resubmits
--
-- Adds: the HomeworkStatus enum, a per-lesson deadline, and the assessment
-- fields (grade / max grade / comment / graded-at / graded-by) plus a
-- resubmission counter and submission timestamp.
--
-- DATA SAFETY: hwStatus previously held free-form strings. Five distinct
-- vocabularies had been written to it, including PENDING (the manual-grading
-- queue) and APPROVED/REJECTED (which are *enrollment* values, written by a
-- teacher endpoint that overloaded this column). Converting a text column
-- straight to an enum would fail on any of those, and the naive ADD COLUMN
-- would silently reset every existing row to NOT_SUBMITTED, destroying
-- history. So the column is normalised first, then cast.

-- 1. Deadline on the lesson.
ALTER TABLE "Lesson" ADD COLUMN "homeworkDueAt" TIMESTAMP(3);

-- 2. Assessment columns, added nullable so existing rows stay valid.
ALTER TABLE "Tracking"
  ADD COLUMN "hwComment" TEXT,
  ADD COLUMN "hwGrade" INTEGER,
  ADD COLUMN "hwMaxGrade" INTEGER,
  ADD COLUMN "hwGradedAt" TIMESTAMP(3),
  ADD COLUMN "hwGradedById" TEXT,
  ADD COLUMN "hwSubmittedAt" TIMESTAMP(3),
  ADD COLUMN "hwResubmitCount" INTEGER NOT NULL DEFAULT 0;

-- 3. The enum type.
CREATE TYPE "HomeworkStatus" AS ENUM (
  'NOT_SUBMITTED',
  'SUBMITTED',
  'UNDER_REVIEW',
  'NEEDS_REVISION',
  'GRADED'
);

-- 4. Normalise every legacy value onto the new vocabulary.
--    PENDING was the teacher's manual-grading queue  -> UNDER_REVIEW
--    APPROVED / REJECTED came from the enrollment endpoint and carry no
--      homework meaning -> UNDER_REVIEW (work exists, not yet graded)
--    anything unrecognised -> NOT_SUBMITTED
UPDATE "Tracking"
SET "hwStatus" = CASE
  WHEN "hwStatus" IN ('NOT_SUBMITTED','SUBMITTED','UNDER_REVIEW','NEEDS_REVISION','GRADED')
    THEN "hwStatus"
  WHEN "hwStatus" IN ('PENDING','APPROVED','REJECTED')
    THEN 'UNDER_REVIEW'
  ELSE 'NOT_SUBMITTED'
END;

-- 5. Cast the column to the enum, then make it NOT NULL with a default.
--    The DROP DEFAULT is mandatory: the baseline gave this column a TEXT
--    default, and ALTER TYPE ... USING only converts stored values, not the
--    default expression. Without the drop, PostgreSQL aborts with 42804
--    ("default cannot be cast automatically"), which is exactly what a fresh
--    `migrate deploy` hit before this line existed.
ALTER TABLE "Tracking" ALTER COLUMN "hwStatus" DROP DEFAULT;

ALTER TABLE "Tracking"
  ALTER COLUMN "hwStatus" TYPE "HomeworkStatus"
  USING "hwStatus"::"HomeworkStatus";

ALTER TABLE "Tracking"
  ALTER COLUMN "hwStatus" SET DEFAULT 'NOT_SUBMITTED'::"HomeworkStatus",
  ALTER COLUMN "hwStatus" SET NOT NULL;

-- 6. Indexes for the teacher's grading queue (all submissions awaiting review)
--    and for the per-lesson view of that queue.
CREATE INDEX "Tracking_hwStatus_idx" ON "Tracking"("hwStatus");
CREATE INDEX "Tracking_lessonId_hwStatus_idx" ON "Tracking"("lessonId", "hwStatus");
