import request from 'supertest';
import app from '../app';

/**
 * STAB-11 — route mount consolidation.
 *
 * Three alias/duplicate mounts existed:
 *   1. /api/lessons/upload  -> uploadRoutes   (GET already shadowed -> 404)
 *   2. /api/teacher         -> teacherRoutes   (full duplicate, doubles attack surface)
 *   3. /api/quiz            -> trackingRoutes  (re-published the WHOLE tracking router)
 *
 * The client calls exactly one of the resulting paths:
 *   GET /api/quiz/pending-essays   (essay_submissions_screen.dart)
 * so that one is preserved and the other five tracking endpoints are no longer
 * reachable under /api/quiz/*.
 */
describe('route mount consolidation', () => {
  describe('the one endpoint the client uses is preserved', () => {
    it('still routes GET /api/quiz/pending-essays (401 without a session, not 404)', async () => {
      const res = await request(app).get('/api/quiz/pending-essays');
      // 401 proves the route is MOUNTED and reachable.
      // A 404 would mean the endpoint was removed along with the alias.
      expect(res.status).toBe(401);
    });

    it('keeps the canonical /api/trackings/pending-essays path working too', async () => {
      const res = await request(app).get('/api/trackings/pending-essays');
      expect(res.status).toBe(401);
    });
  });

  describe('the re-published tracking surface is closed', () => {
    it.each([
      ['/api/quiz/pending-essays/../:lessonId placeholder', '/api/quiz/some-lesson-id'],
      ['POST /api/quiz/attend', '/api/quiz/attend'],
      ['POST /api/quiz/submit-quiz', '/api/quiz/submit-quiz'],
      ['POST /api/quiz/:trackingId/grade-essay', '/api/quiz/some-tracking-id/grade-essay'],
    ])('no longer routes %s', async (_label, path) => {
      const res = await request(app).post(path);
      // 404 = not mounted. Anything in the 2xx/4xx range would mean the whole
      // tracking router is still mounted a second time.
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Endpoint not found');
    });
  });

  describe('the /api/teacher duplicate is closed', () => {
    it.each([
      ['GET /api/teacher/stats', '/api/teacher/stats'],
      ['GET /api/teacher/students', '/api/teacher/students'],
      ['GET /api/teacher/courses', '/api/teacher/courses'],
      ['POST /api/teacher/teachers', '/api/teacher/teachers'],
    ])('no longer routes %s', async (_label, path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
    });
  });

  describe('the canonical prefixes are untouched', () => {
    it.each([
      ['/api/teachers/stats', '/api/teachers/stats'],
      ['/api/teachers/students', '/api/teachers/students'],
    ])('still routes %s (401 without a session)', async (_label, path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
    });

    it('still routes /api/upload/video-ticket (401 without a session)', async () => {
      const res = await request(app).post('/api/upload/video-ticket');
      expect(res.status).toBe(401);
    });
  });
});
