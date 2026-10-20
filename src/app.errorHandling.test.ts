import request from 'supertest';
import app from './app';

describe('malformed request bodies are client errors, not server errors', () => {
  // express.json() rejects an unparseable body with a 400-class error whose
  // `type` is 'entity.parse.failed'. The terminal error handler used to flatten
  // every error to 500, so a malformed body looked like a server crash and
  // pushed 5xx noise into monitoring. These tests pin the correct contract.

  const malformedJsonEndpoints = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/store/checkout',
    '/api/teachers/teachers',
  ];

  it.each(malformedJsonEndpoints)('returns 400 (not 500) for malformed JSON on %s', async (path) => {
    const response = await request(app)
      .post(path)
      .set('Content-Type', 'application/json')
      .send('{"identifier": "01000000000", ');

    expect(response.status).toBe(400);
    expect(response.status).not.toBe(500);
  });

  it('returns 400 for a body that is not JSON at all', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('this is definitely not json');

    expect(response.status).toBe(400);
  });

  it('does not leak internals in the malformed-body response', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/stack/i);
    expect(body).not.toMatch(/node_modules/);
    expect(body).not.toMatch(/at Object\./);
    expect(response.body.error).toEqual(expect.any(String));
  });

  it('returns 413 when the body exceeds the configured limit', async () => {
    const oversized = JSON.stringify({ blob: 'x'.repeat(11 * 1024 * 1024) });

    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(oversized);

    expect(response.status).toBe(413);
    expect(response.status).not.toBe(500);
  });

  it('still answers 404 for an unknown route', async () => {
    const response = await request(app).get('/api/definitely-not-a-route');
    expect(response.status).toBe(404);
  });

  it('still answers 401 for a protected route with no token', async () => {
    const response = await request(app).post('/api/store/checkout').send({ courseId: 'x' });
    expect([401, 400]).toContain(response.status);
    expect(response.status).not.toBe(500);
  });
});