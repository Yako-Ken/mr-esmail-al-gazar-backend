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

  it('rejects an unauthenticated request to a protected route with 401', async () => {
    const res = await request(app).get('/api/courses');
    expect(res.status).toBe(401);
  });
});
