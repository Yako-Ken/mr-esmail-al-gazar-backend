// Smoke test — boots the real Express app + SQLite and hits key endpoints.
// Run: npx ts-node test/smoke.ts
import dotenv from 'dotenv';
dotenv.config();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./prisma/dev.db';

import request from 'supertest';
import app from '../src/app';

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name} — ${detail}`);
};

async function main() {
  console.log('🔥 SMOKE TEST — EduTech LMS Backend\n');

  // 1. Health
  const health = await request(app).get('/health');
  check('GET /health', health.status === 200, `status=${health.status} body=${JSON.stringify(health.body)}`);

  // 2. Landing page
  const landing = await request(app).get('/');
  check('GET / (landing)', landing.status === 200 && landing.text.includes('ElGazar'), `status=${landing.status}`);

  // 3. Privacy policy
  const privacy = await request(app).get('/privacy-policy.html');
  check('GET /privacy-policy.html', privacy.status === 200 && privacy.text.includes('الخصوصية'), `status=${privacy.status}`);

  // 4. Terms
  const terms = await request(app).get('/terms.html');
  check('GET /terms.html', terms.status === 200 && terms.text.includes('شروط'), `status=${terms.status}`);

  // 5. Demo teacher login
  const teacherLogin = await request(app)
    .post('/api/auth/login')
    .send({ phone: '01000000001', password: 'Demo@2026' });
  const teacherOk = teacherLogin.status === 200 && !!teacherLogin.body.token;
  check('POST /api/auth/login (teacher)', teacherOk, `status=${teacherLogin.status} hasToken=${!!teacherLogin.body.token}`);
  const teacherToken = teacherLogin.body.token as string;

  // 6. Demo student login
  const studentLogin = await request(app)
    .post('/api/auth/login')
    .send({ phone: '01000000002', password: 'Demo@2026' });
  const studentOk = studentLogin.status === 200 && !!studentLogin.body.token;
  check('POST /api/auth/login (student)', studentOk, `status=${studentLogin.status} hasToken=${!!studentLogin.body.token}`);
  const studentToken = studentLogin.body.token as string;

  // 7. Demo parent login
  const parentLogin = await request(app)
    .post('/api/auth/login')
    .send({ phone: '01000000003', password: 'Demo@2026' });
  check('POST /api/auth/login (parent)', parentLogin.status === 200, `status=${parentLogin.status}`);

  // 8. Student notifications (auth-protected)
  if (studentToken) {
    const notifs = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${studentToken}`);
    check('GET /api/notifications (student)', notifs.status === 200, `status=${notifs.status} count=${notifs.body.count}`);
  } else {
    check('GET /api/notifications (student)', false, 'skipped — no token');
  }

  // 9. Student courses / store
  if (studentToken) {
    const store = await request(app)
      .get('/api/store/courses')
      .set('Authorization', `Bearer ${studentToken}`);
    const storeOk = store.status === 200;
    check('GET /api/store/courses', storeOk, `status=${store.status}`);
  } else {
    check('GET /api/store/courses', false, 'skipped — no token');
  }

  // 10. Teacher dashboard data
  if (teacherToken) {
    const teacherCourses = await request(app)
      .get('/api/teachers/courses')
      .set('Authorization', `Bearer ${teacherToken}`);
    check('GET /api/teachers/courses', teacherCourses.status === 200, `status=${teacherCourses.status}`);
  } else {
    check('GET /api/teachers/courses', false, 'skipped — no token');
  }

  // 11. OTP backdoor must be closed (security regression)
  const otp = await request(app)
    .post('/api/auth/student/verify-otp')
    .send({ phone: '01000000000', code: '1234' });
  check('OTP backdoor closed (501)', otp.status === 501, `status=${otp.status}`);

  // Summary
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 SMOKE TEST RESULT: ${passed}/${results.length} passed`);
  if (passed === results.length) {
    console.log('🎉 ALL CHECKS PASSED — backend is ready for client trial!');
  } else {
    console.log('⚠️  Some checks failed — review above.');
  }
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
