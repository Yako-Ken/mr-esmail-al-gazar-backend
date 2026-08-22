-- Courses are private drafts until an owner explicitly publishes them.
ALTER TABLE "Course" ADD COLUMN "isPublished" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Course" ADD COLUMN "publishedAt" DATETIME;

CREATE INDEX "Course_isPublished_createdAt_idx"
ON "Course"("isPublished", "createdAt");
