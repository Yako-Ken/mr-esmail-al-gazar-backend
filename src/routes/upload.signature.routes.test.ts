import fs from 'fs';
import path from 'path';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import app from '../app';
import { BunnyService } from '../utils/bunny.service';

import prisma from '../config/prisma';

/**
 * Defect 1 — upload validation was filename-trusting.
 *
 * `upload.routes.ts` decided what a file *was* from three attacker-controlled
 * strings: `file.originalname`'s extension, the client-supplied `Content-Type`
 * (surfaced as `file.mimetype`), and the multipart field name. Nothing ever
 * looked at the bytes. So a payload named `avatar.jpg` and declared
 * `image/jpeg` was written to the public Bunny CDN bucket under an image name
 * and extension, and any later consumer that trusted that name — a CDN
 * content-type override, a direct object URL, a future "serve uploads inline"
 * feature — would be serving whatever the uploader actually chose.
 *
 * These tests pin the replacement: the first bytes of the file decide whether
 * it is accepted, and the extension handed to the CDN comes from the detected
 * content rather than from the name the client chose.
 *
 * The negative cases are the ones that matter — they are the attack. They fail
 * against the pre-fix code, which answers 200 and uploads the payload.
 *
 * The positive cases are the guard rail: content-based checking must not become
 * "reject everything", and a legitimate PNG sent with a stale `.jpg` name must
 * still be accepted and stored under the extension its bytes actually imply.
 *
 * Note on the fixtures: the attack payloads below are deliberately plain
 * non-image byte patterns (native binaries, an archive header, prose). They need
 * no executable or script-like text to prove the point, and keeping them inert
 * is deliberate — a fixture that looks like a real web shell would get this test
 * file quarantined by endpoint antivirus.
 *
 * Phone budget: this file owns 01000000942.
 */

// `phone` is unique and every suite shares one database. Never reuse another
// suite's fixture.
const PHONE = '01000000942';
const PASSWORD = 'UploadSig@2026';
const COURSE_PREFIX = 'UploadSig-Course-';

let teacherId: string;
let teacherToken: string;

// Unique sentinel substring. The 415 path must delete the multer temp file, so
// this lets the test prove the payload was never left on disk without caring
// what other suites write into the shared temp directory concurrently.
const PROBE = 'upload-signature-probe';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// ── Byte fixtures ──────────────────────────────────────────────────────────────
// Real containers, hand-assembled. Only the leading signature matters to the
// validator, so a header plus a short body is a faithful fixture and keeps the
// test hermetic: no binary blobs checked in, no image library needed.

const jpegBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'binary'),
    Buffer.from([0x01, 0x01, 0x00]),
    Buffer.from('upload-signature-jpeg-body', 'utf8'),
    Buffer.from([0xff, 0xd9]),
  ]);

const pngBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR', 'ascii'),
    Buffer.from('upload-signature-png-body', 'utf8'),
  ]);

const webpBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8 ', 'ascii'),
    Buffer.from('upload-signature-webp-body', 'utf8'),
  ]);

const gifBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from('upload-signature-gif-body', 'utf8'),
  ]);

const pdfBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'ascii'),
    Buffer.from('1 0 obj<</Type/Catalog>>endobj\n', 'ascii'),
    Buffer.from('trailer<</Root 1 0 R>>\n%%EOF\n', 'ascii'),
  ]);

/** Payloads that are not images, whatever the name claims. None is executable. */
const prosePayload = (): Buffer =>
  Buffer.from(
    'This upload is a plain text note, not an image of any kind.\n' +
      'It carries no signature bytes at all.\n',
    'utf8',
  );
const elfPayload = (): Buffer =>
  Buffer.concat([
    // Native 64-bit ELF header: a binary the CDN should never hold under .jpg
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
    Buffer.alloc(8, 0x00),
    Buffer.from('upload-signature-elf-body', 'utf8'),
  ]);
const zipPayload = (): Buffer =>
  Buffer.concat([
    // Local file header of a zip archive, renamed to look like a photo
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from([0x14, 0x00, 0x00, 0x00, 0x08, 0x00]),
    Buffer.from('upload-signature-zip-body', 'utf8'),
  ]);
const gzipPayload = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
    Buffer.alloc(4, 0x00),
    Buffer.from('upload-signature-gzip-body', 'utf8'),
  ]);

const TEMP_DIR = path.join(process.cwd(), 'uploads', 'temp', 'multipart');
const probeFilesStillOnDisk = (): string[] => {
  if (!fs.existsSync(TEMP_DIR)) return [];
  return fs.readdirSync(TEMP_DIR).filter((f) => f.includes(PROBE));
};

const cleanupFixtures = async (): Promise<void> => {
  const courses = await prisma.course.findMany({
    where: { title: { startsWith: COURSE_PREFIX } },
    select: { id: true },
  });
  const courseIds = courses.map((c) => c.id);
  if (courseIds.length > 0) {
    await prisma.quiz.deleteMany({ where: { lesson: { courseId: { in: courseIds } } } });
    await prisma.tracking.deleteMany({ where: { lesson: { courseId: { in: courseIds } } } });
    await prisma.lessonProgress.deleteMany({ where: { courseId: { in: courseIds } } });
    await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: courseIds } } });
    await prisma.lesson.deleteMany({ where: { courseId: { in: courseIds } } });
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
  }
  for (const f of probeFilesStillOnDisk()) {
    fs.rmSync(path.join(TEMP_DIR, f), { force: true });
  }
};

beforeAll(async () => {
  await cleanupFixtures();

  const row = await prisma.user.upsert({
    where: { phone: PHONE },
    update: {
      role: 'TEACHER',
      status: 'approved',
      isApproved: true,
      isVerified: true,
      password: await bcrypt.hash(PASSWORD, 10),
    },
    create: {
      name: 'Upload Signature Teacher',
      phone: PHONE,
      email: `upload-signature-${PHONE}@example.com`,
      password: await bcrypt.hash(PASSWORD, 10),
      role: 'TEACHER',
      status: 'approved',
      isApproved: true,
      isVerified: true,
    },
  });
  teacherId = row.id;

  const login = await request(app)
    .post('/api/auth/login')
    .set('X-Device-Name', 'upload-signature')
    .send({ identifier: PHONE, password: PASSWORD });
  expect(login.status).toBe(200);
  teacherToken = login.body.token as string;
});

afterAll(async () => {
  jest.restoreAllMocks();
  await cleanupFixtures();
  await prisma.$disconnect();
});

beforeEach(() => {
  jest.restoreAllMocks();
  // Stand in for the CDN, so a request that reaches the upload step resolves to
  // 200 with an inspectable remote path. A handler that calls this for a
  // payload it should have rejected is therefore caught by the 415 assertion.
  jest
    .spyOn(BunnyService, 'uploadFileFromPath')
    .mockImplementation(async (_filePath: string, remotePath: string) =>
      `https://cdn.test.invalid/${remotePath}`,
    );
});

const postThumbnail = (originalName: string, contents: Buffer, contentType = 'image/jpeg') =>
  request(app)
    .post('/api/upload/thumbnail')
    .set(bearer(teacherToken))
    .attach('thumbnail', contents, { filename: originalName, contentType });

const postPdf = (originalName: string, contents: Buffer, contentType = 'application/pdf') =>
  request(app)
    .post('/api/upload/pdf')
    .set(bearer(teacherToken))
    .attach('pdf', contents, { filename: originalName, contentType });

describe('accepted uploads: the bytes decide what the file is', () => {
  it('accepts a real JPEG and stores it under the extension its content implies', async () => {
    const res = await postThumbnail(`${PROBE}-real.jpg`, jpegBytes());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toContain('/thumbnails/lesson-thumbnails/');
    expect(res.body.filename).toMatch(/\.jpg$/);
    expect(BunnyService.uploadFileFromPath).toHaveBeenCalledTimes(1);
  });

  it('accepts WebP and GIF thumbnails too', async () => {
    const webp = await postThumbnail(`${PROBE}-real.webp`, webpBytes(), 'image/webp');
    expect(webp.status).toBe(200);
    expect(webp.body.filename).toMatch(/\.webp$/);

    const gif = await postThumbnail(`${PROBE}-real.gif`, gifBytes(), 'image/gif');
    expect(gif.status).toBe(200);
    expect(gif.body.filename).toMatch(/\.gif$/);
  });

  it('accepts a genuine PNG sent under a stale .jpg name and renames it from its bytes', async () => {
    // A real client bug, or a renamed file, must not become a rejection — and
    // the extension handed to the CDN must describe the content rather than
    // repeat the client's claim. Before the fix this stored it as ".jpg".
    const res = await postThumbnail(`${PROBE}-mislabelled.jpg`, pngBytes(), 'image/jpeg');

    expect(res.status).toBe(200);
    expect(res.body.filename).toMatch(/\.png$/);
    expect(res.body.filename).not.toMatch(/\.jpg$/);
    expect(res.body.url).toMatch(/\.png$/);
  });

  it('accepts a real PDF on the pdf endpoint', async () => {
    const res = await postPdf(`${PROBE}-homework.pdf`, pdfBytes());

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('/pdfs/');
    expect(res.body.filename).toMatch(/\.pdf$/);
  });
});

describe('rejected uploads: a lying filename no longer buys acceptance', () => {
  it('refuses a plain-text payload named .jpg even when the client declares image/jpeg', async () => {
    const res = await postThumbnail(`${PROBE}-note.jpg`, prosePayload(), 'image/jpeg');

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/does not match|unsupported|rejected/i);
    expect(BunnyService.uploadFileFromPath).not.toHaveBeenCalled();
    expect(probeFilesStillOnDisk()).toEqual([]);
  });

  it('refuses the same plain-text payload named .png', async () => {
    const res = await postThumbnail(`${PROBE}-note.png`, prosePayload(), 'image/png');

    expect(res.status).toBe(415);
    expect(BunnyService.uploadFileFromPath).not.toHaveBeenCalled();
  });

  it('refuses a native binary named .jpg', async () => {
    const res = await postThumbnail(`${PROBE}-binary.jpg`, elfPayload(), 'image/jpeg');

    expect(res.status).toBe(415);
    expect(BunnyService.uploadFileFromPath).not.toHaveBeenCalled();
  });

  it('refuses a zip archive renamed to .jpg', async () => {
    const res = await postThumbnail(`${PROBE}-archive.jpg`, zipPayload(), 'image/jpeg');

    expect(res.status).toBe(415);
    expect(BunnyService.uploadFileFromPath).not.toHaveBeenCalled();
  });

  it('refuses a gzip stream renamed to .png', async () => {
    const res = await postThumbnail(`${PROBE}-archive.png`, gzipPayload(), 'image/png');

    expect(res.status).toBe(415);
    expect(BunnyService.uploadFileFromPath).not.toHaveBeenCalled();
  });

  it('refuses a real PDF submitted to the image endpoint', async () => {
    // The content is a document and the field is an image field. Nothing about
    // the filename or the declared type makes it an image.
    const res = await postThumbnail(`${PROBE}-really-a-pdf.jpg`, pdfBytes(), 'image/jpeg');

    expect(res.status).toBe(415);
    expect(BunnyService.uploadFileFromPath).not.toHaveBeenCalled();
  });

  it('refuses a real image submitted to the pdf endpoint', async () => {
    const res = await postPdf(`${PROBE}-not-a-pdf.pdf`, jpegBytes(), 'application/pdf');

    expect(res.status).toBe(415);
    expect(BunnyService.uploadFileFromPath).not.toHaveBeenCalled();
  });

  it('never lets a client Content-Type on an empty body through', async () => {
    const res = await postThumbnail(`${PROBE}-empty.jpg`, Buffer.alloc(0), 'image/jpeg');

    expect(res.status).toBe(415);
    expect(BunnyService.uploadFileFromPath).not.toHaveBeenCalled();
  });
});

describe('the multi-field lesson upload validates before it has side effects', () => {
  let courseId: string;

  beforeAll(async () => {
    const course = await prisma.course.create({
      data: {
        teacherId,
        title: `${COURSE_PREFIX}signature`,
        subject: `${COURSE_PREFIX}math`,
        grade: `${COURSE_PREFIX}grade-1`,
        price: 0,
        priceMinor: 0,
        isPublished: true,
      },
    });
    courseId = course.id;
  });

  const postLesson = (thumbnail: { name: string; contents: Buffer; contentType: string }) => {
    const req = request(app)
      .post('/api/upload')
      .set(bearer(teacherToken))
      .field('subject', `${COURSE_PREFIX}math`)
      .field('grade', `${COURSE_PREFIX}grade-1`)
      .field('title', `${PROBE}-lesson`)
      .field('courseId', courseId)
      // Video bytes are not signature-checked on this path (see the module
      // note), so this fixture only has to satisfy the "a video file was
      // supplied" requirement and get past the CDN stub.
      .attach('video', jpegBytes(), { filename: `${PROBE}-clip.mp4`, contentType: 'video/mp4' });
    return req.attach('thumbnail', thumbnail.contents, {
      filename: thumbnail.name,
      contentType: thumbnail.contentType,
    });
  };

  it('rejects the whole request when the thumbnail lies, and writes no lesson', async () => {
    const res = await postLesson({
      name: `${PROBE}-lesson-thumb.jpg`,
      contents: prosePayload(),
      contentType: 'image/jpeg',
    });

    expect(res.status).toBe(415);
    // Nothing may have been uploaded: a rejected payload must not be streamed to
    // the CDN on its way to being rejected, even as part of an otherwise valid
    // multi-field request.
    expect(BunnyService.uploadFileFromPath).not.toHaveBeenCalled();
    expect(await prisma.lesson.count({ where: { title: `${PROBE}-lesson` } })).toBe(0);
  });

  it('still creates the lesson when the thumbnail is a genuine image', async () => {
    const res = await postLesson({
      name: `${PROBE}-lesson-ok.jpg`,
      contents: jpegBytes(),
      contentType: 'image/jpeg',
    });

    expect(res.status).toBe(201);
    expect(await prisma.lesson.count({ where: { title: `${PROBE}-lesson` } })).toBe(1);
  });
});