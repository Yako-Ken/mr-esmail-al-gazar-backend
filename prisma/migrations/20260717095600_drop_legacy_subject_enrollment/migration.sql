-- DropIndex
DROP INDEX "Subject_code_key";

-- DropIndex
DROP INDEX "Enrollment_studentId_subjectId_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Subject";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Enrollment";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Lesson" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subject" TEXT,
    "grade" TEXT,
    "courseId" TEXT,
    "teacherId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "videoUrl" TEXT,
    "bunnyVideoId" TEXT,
    "videoLibraryId" TEXT,
    "thumbnailUrl" TEXT,
    "pdfUrl" TEXT,
    "description" TEXT,
    "homeworkText" TEXT,
    "homeworkPdfUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Lesson_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Lesson_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Lesson" ("bunnyVideoId", "courseId", "createdAt", "description", "grade", "homeworkPdfUrl", "homeworkText", "id", "pdfUrl", "subject", "teacherId", "thumbnailUrl", "title", "updatedAt", "videoLibraryId", "videoUrl") SELECT "bunnyVideoId", "courseId", "createdAt", "description", "grade", "homeworkPdfUrl", "homeworkText", "id", "pdfUrl", "subject", "teacherId", "thumbnailUrl", "title", "updatedAt", "videoLibraryId", "videoUrl" FROM "Lesson";
DROP TABLE "Lesson";
ALTER TABLE "new_Lesson" RENAME TO "Lesson";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

