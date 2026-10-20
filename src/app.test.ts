import request from 'supertest';
import app from './app';

describe('app', () => {
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns 404 for an unknown route', async () => {
    const res = await request(app).get('/api/this-route-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Endpoint not found');
  });

  it('rejects login with a 400 when the body fails validation', async () => {
    const res = await request(app).post('/api/auth/login').send({ identifier: '01000000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request body');
  });

  it.each(['TEACHER', 'ADMIN', 'ASSISTANT', 'SUPER_ADMIN'])(
    'rejects public registration for internal role %s before touching the database',
    async (role) => {
      const res = await request(app).post('/api/auth/register').send({
        name: 'Internal Role Attempt',
        phone: '01012345678',
        email: 'internal@example.com',
        password: 'password123',
        role,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid request body');
    },
  );

  it('rejects an unauthenticated request to a protected route with 401', async () => {
    const res = await request(app).get('/api/courses');
    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated single-course request with 401', async () => {
    // The course payload embeds the teacher's payout identifiers
    // (vodafoneCashNumber / instapayHandle), so this route must never be
    // reachable without a session. The public catalogue is /api/store/courses.
    const res = await request(app).get('/api/courses/demo_course_001');
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('teacher');
  });

  it('never exposes permanent media URLs from the public lesson catalog', async () => {
    const res = await request(app).get('/api/lessons/public');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const lesson of res.body) {
      expect(lesson).not.toHaveProperty('videoUrl');
      expect(lesson).not.toHaveProperty('bunnyVideoId');
      expect(lesson).not.toHaveProperty('pdfUrl');
    }
  });

  it('requires authentication for lesson playback URLs', async () => {
    const res = await request(app).get('/api/lessons/unknown/playback');
    expect(res.status).toBe(401);
  });

  it('serves an informational payment return without activating anything', async () => {
    const res = await request(app).get('/payment/return?orderId=demo-order');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.text).toContain('جارٍ تأكيد الدفع');
  });
});
