import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

export async function cleanupOrphanedFiles() {
  console.log('🧹 Starting orphaned files cleanup...');

  if (!fs.existsSync(UPLOADS_DIR)) {
    console.log('📁 No uploads directory found');
    return;
  }

  // Get all video and thumbnail URLs from database
  const lessons = await prisma.lesson.findMany({
    select: { videoUrl: true, thumbnailUrl: true, homeworkPdfUrl: true },
  });

  const courses = await prisma.course.findMany({
    select: { thumbnailUrl: true },
  });

  // Collect all used file paths - use basename for matching
  const validFilesSet = new Set<string>();
  
  for (const lesson of lessons) {
    if (lesson.videoUrl) validFilesSet.add(path.basename(lesson.videoUrl));
    if (lesson.thumbnailUrl) validFilesSet.add(path.basename(lesson.thumbnailUrl));
    if (lesson.homeworkPdfUrl) validFilesSet.add(path.basename(lesson.homeworkPdfUrl));
  }

  for (const course of courses) {
    if (course.thumbnailUrl) validFilesSet.add(path.basename(course.thumbnailUrl));
  }

  console.log(`📊 Found ${validFilesSet.size} files referenced in database`);

  // Check uploads directory for orphaned files
  const subdirs = ['videos', 'thumbnails', 'pdfs', '', 'temp'];
  let deletedCount = 0;

  for (const subdir of subdirs) {
    const dir = subdir ? path.join(UPLOADS_DIR, subdir) : UPLOADS_DIR;
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      const fullPath = path.join(dir, file);
      
      try {
        if (!fs.statSync(fullPath).isFile()) continue;
        
        const fileName = path.basename(fullPath);
        
        if (!validFilesSet.has(fileName)) {
          fs.unlinkSync(fullPath);
          console.log(`🗑️  Deleted orphaned file: ${fileName}`);
          deletedCount++;
        }
      } catch (err) {
        console.error(`⚠️  Failed to process ${fullPath}:`, err);
      }
    }
  }

  console.log(`✅ Cleanup complete. Deleted ${deletedCount} orphaned files.`);
}

cleanupOrphanedFiles()
  .catch(console.error)
  .finally(() => prisma.$disconnect());