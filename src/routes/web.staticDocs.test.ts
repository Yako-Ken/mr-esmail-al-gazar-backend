import request from 'supertest';
import app from '../app';
it('serves privacy from the file, not an inline copy', async () => {
  const res = await request(app).get('/privacy-policy.html');
  expect(res.status).toBe(200);
  const file = require('fs').readFileSync('public/privacy-policy.html', 'utf8');
  expect(res.text).toBe(file);
  expect(res.text).not.toMatch(/res\.send\(\`/);
  const sections = (res.text.match(/<h2/g) || []).length;
  expect(sections).toBeGreaterThanOrEqual(9);
});
it('serves terms from the file too', async () => {
  const res = await request(app).get('/terms.html');
  expect(res.status).toBe(200);
  const file = require('fs').readFileSync('public/terms.html', 'utf8');
  expect(res.text).toBe(file);
});
