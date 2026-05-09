-- Migration: Add bunnyVideoId and videoLibraryId to Lesson table
ALTER TABLE "Lesson" ADD COLUMN "bunnyVideoId" TEXT;
ALTER TABLE "Lesson" ADD COLUMN "videoLibraryId" TEXT;
