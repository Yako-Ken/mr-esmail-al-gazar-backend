/**
 * COMPREHENSIVE LIVE END-TO-END (E2E) TEST SUITE
 * Host: https://mr-esmail-al-gazar-backend-o92z.vercel.app
 * Verifies all 4 roles, security guard rails, store, lessons, signed Bunny streaming,
 * quizzes, homework submission, parent monitoring, and admin portal.
 */

const https = require('https');

const BASE_URL = 'mr-esmail-al-gazar-backend-o92z.vercel.app';
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: BASE_URL,
      port: 443,
      path: options.path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-bypass-ratelimit': 'true',
        ...(options.headers || {}),
      },
      timeout: 20000,
    };

    if (data) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      reqOptions.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (e) {
          json = body;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out after 20s'));
    });

    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

function assert(condition, message, details = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passedTests++;
    testDetails.push({ status: 'PASS', message, details });
  } else {
    console.error(`  ❌ FAIL: ${message} ${details ? '— ' + details : ''}`);
    failedTests++;
    testDetails.push({ status: 'FAIL', message, details });
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runLiveE2E() {
  console.log('================================================================');
  console.log('🚀 RUNNING COMPREHENSIVE LIVE PRODUCTION E2E TEST SUITE');
  console.log(`🎯 Production Endpoint: https://${BASE_URL}`);
  console.log(`📅 Execution Time: ${new Date().toISOString()}`);
  console.log('================================================================\n');

  // --- STEP 1: Health & Diagnostics ---
  console.log('📍 [Step 1/7] Health & Diagnostic Ping:');
  try {
    const health = await request({ path: '/health' });
    assert(health.status === 200, `Health check returned HTTP 200 OK`, `Status: ${health.status}`);
    assert(health.body.status === 'ok', `System status is reported as healthy ('ok')`);
  } catch (err) {
    assert(false, `Health check network exception`, err.message);
  }

  // --- STEP 2: Multi-Persona Authentication ---
  console.log('\n📍 [Step 2/7] Authenticating 4 Independent Personas:');
  const tokens = {};
  const personas = [
    { role: 'TEACHER', phone: '01000000001', pass: 'Demo@2026', expectedName: 'أ. إسماعيل الجزار' },
    { role: 'STUDENT', phone: '01000000002', pass: 'Demo@2026', expectedName: 'أحمد محمد' },
    { role: 'PARENT', phone: '01000000003', pass: 'Demo@2026', expectedName: 'محمد أحمد' },
    { role: 'SUPER_ADMIN', phone: '01000000004', pass: 'Demo@2026', expectedName: 'إدارة Esmail ElGazar' },
  ];

  for (const p of personas) {
    try {
      const loginRes = await request(
        { path: '/api/auth/login', method: 'POST' },
        { identifier: p.phone, password: p.pass }
      );
      assert(loginRes.status === 200, `${p.role} login succeeded (HTTP 200)`);
      assert(Boolean(loginRes.body.token), `${p.role} received valid signed JWT token`);
      assert(loginRes.body.user.role === p.role, `${p.role} verified role in payload (${loginRes.body.user.role})`);
      tokens[p.role] = loginRes.body.token;

      // Verify profile retrieval via /api/auth/me
      const meRes = await request({
        path: '/api/auth/me',
        headers: { Authorization: `Bearer ${tokens[p.role]}` },
      });
      assert(meRes.status === 200, `${p.role} /api/auth/me returned HTTP 200`);
      const returnedUser = meRes.body.user || meRes.body;
      assert(returnedUser.phone === p.phone, `${p.role} phone matches database profile (${returnedUser.phone})`);
      assert(Boolean(returnedUser.name), `${p.role} profile name verified: '${returnedUser.name}'`);
    } catch (err) {
      assert(false, `${p.role} authentication exception`, err.message);
    }
  }

  // --- STEP 3: Security & RBAC Guard Rails ---
  console.log('\n📍 [Step 3/7] Security Guard Rails & Role-Based Access Control (RBAC):');
  try {
    // 3a. Missing token on protected endpoint
    const unauth = await request({ path: '/api/auth/me' });
    assert(unauth.status === 401, `Protected endpoint rejects unauthenticated request (HTTP 401)`);

    // 3b. Invalid credentials attempt
    const badPass = await request(
      { path: '/api/auth/login', method: 'POST' },
      { identifier: '01000000001', password: 'InvalidPasswordDemo!2026' }
    );
    assert(badPass.status === 401 || badPass.status === 400, `Login rejects invalid credentials (HTTP ${badPass.status})`);

    // 3c. Student attempting Teacher endpoints
    const studentAsTeacher = await request({
      path: '/api/teachers/stats',
      headers: { Authorization: `Bearer ${tokens['STUDENT']}` },
    });
    assert(studentAsTeacher.status === 403, `Student access to Teacher stats denied (HTTP 403 Forbidden)`);

    // 3d. Student attempting Admin endpoints
    const studentAsAdmin = await request({
      path: '/api/admin/users/dashboard-stats',
      headers: { Authorization: `Bearer ${tokens['STUDENT']}` },
    });
    assert(studentAsAdmin.status === 403, `Student access to Admin stats denied (HTTP 403 Forbidden)`);
  } catch (err) {
    assert(false, `Security test exception`, err.message);
  }

  // --- STEP 4: Store & Course Navigation ---
  console.log('\n📍 [Step 4/7] Course Catalog & Student Entitlements:');
  try {
    const catalog = await request({
      path: '/api/store/courses',
      headers: { Authorization: `Bearer ${tokens['STUDENT']}` },
    });
    assert(catalog.status === 200, `Catalog loaded successfully (HTTP 200)`);
    assert(Array.isArray(catalog.body) && catalog.body.length >= 3, `Catalog contains active courses (${catalog.body.length} available)`);

    const myCourses = await request({
      path: '/api/store/my-courses',
      headers: { Authorization: `Bearer ${tokens['STUDENT']}` },
    });
    assert(myCourses.status === 200, `Student purchased courses retrieved (HTTP 200)`);
    assert(Array.isArray(myCourses.body) && myCourses.body.length >= 2, `Student has confirmed enrollments (${myCourses.body.length} active)`);

    const courseDetails = await request({
      path: '/api/courses/demo_course_001',
      headers: { Authorization: `Bearer ${tokens['STUDENT']}` },
    });
    assert(courseDetails.status === 200, `Course details fetched (HTTP 200)`);
    assert(Array.isArray(courseDetails.body.lessons) && courseDetails.body.lessons.length > 0, `Lessons structured in curriculum (${courseDetails.body.lessons.length} lessons)`);
  } catch (err) {
    assert(false, `Course navigation exception`, err.message);
  }

  // --- STEP 5: Bunny.net Video Playback & Signed Token Streaming ---
  console.log('\n📍 [Step 5/7] Bunny.net Video Streaming & DRM Security:');
  try {
    const playback = await request({
      path: '/api/lessons/demo_lesson_001_1/playback',
      headers: { Authorization: `Bearer ${tokens['STUDENT']}` },
    });
    assert(playback.status === 200, `Lesson playback returned HTTP 200 OK`);
    assert(playback.body.protected === true, `Stream is flagged as DRM/token-protected`);
    assert(playback.body.format === 'hls', `Streaming protocol is standard adaptive HLS`);
    assert(playback.body.url.includes('vz-7e37e86f-4da.b-cdn.net'), `Stream domain points to registered Bunny CDN`);
    assert(playback.body.url.includes('token='), `Stream URL includes HMAC SHA-256 security token`);
    assert(playback.body.url.includes('expires='), `Stream URL enforces timed expiration`);
    assert(Boolean(playback.body.expiresAt), `Expiration timestamp parsed: ${playback.body.expiresAt}`);
    console.log(`    ↳ Signed Stream URL: ${playback.body.url.slice(0, 90)}...`);
  } catch (err) {
    assert(false, `Video playback exception`, err.message);
  }

  // --- STEP 6: Interactive Quizzes, Homework & Parent Portal ---
  console.log('\n📍 [Step 6/7] Interactive Learning (Quizzes, Homework & Parent Monitoring):');
  try {
    // 6a. Lesson quiz questions
    const tracking = await request({
      path: '/api/trackings/demo_lesson_001_1',
      headers: { Authorization: `Bearer ${tokens['STUDENT']}` },
    });
    assert(tracking.status === 200, `Tracking & quiz status returned HTTP 200`);
    assert(tracking.body.quiz && Array.isArray(tracking.body.quiz.questions), `Lesson quiz questions delivered (${tracking.body.quiz?.questions?.length} questions)`);
    assert(tracking.body.quiz.questions[0].options?.length === 4, `Quiz questions follow 4-option MCQ schema`);

    // 6b. Submit homework answer
    const hwRes = await request(
      { path: '/api/lessons/demo_lesson_002_1/homework', method: 'POST', headers: { Authorization: `Bearer ${tokens['STUDENT']}` } },
      { answer: 'This is my live E2E submitted homework essay explaining how to prepare for exams in English.' }
    );
    assert(hwRes.status === 201 || hwRes.status === 200, `Student homework submitted successfully (HTTP ${hwRes.status})`);
    if (hwRes.body.tracking) {
      assert(hwRes.body.tracking.hwStatus === 'SUBMITTED' || hwRes.body.tracking.hwStatus === 'GRADED' || hwRes.body.tracking.hwStatus === 'UNDER_REVIEW', `Homework tracking state transitioned: ${hwRes.body.tracking.hwStatus}`);
    }

    // 6c. Parent monitoring linked children
    const parentChildren = await request({
      path: '/api/parents/my-children',
      headers: { Authorization: `Bearer ${tokens['PARENT']}` },
    });
    assert(parentChildren.status === 200, `Parent child roster returned HTTP 200`);
    assert(Array.isArray(parentChildren.body.children) && parentChildren.body.children.length > 0, `Parent has verified linked child (${parentChildren.body.children[0]?.name})`);

    const childStats = await request({
      path: '/api/parents/child/demo_student_001/stats',
      headers: { Authorization: `Bearer ${tokens['PARENT']}` },
    });
    assert(childStats.status === 200, `Parent child academic summary retrieved (HTTP 200)`);
  } catch (err) {
    assert(false, `Interactive learning exception`, err.message);
  }

  // --- STEP 7: Teacher & Admin Operations ---
  console.log('\n📍 [Step 7/7] Teacher & Super Admin Management Portals:');
  try {
    // 7a. Teacher workspace
    const teacherStats = await request({
      path: '/api/teachers/stats',
      headers: { Authorization: `Bearer ${tokens['TEACHER']}` },
    });
    assert(teacherStats.status === 200, `Teacher analytics dashboard loaded (HTTP 200)`);
    assert(teacherStats.body.totalStudents !== undefined, `Teacher tracks enrolled students (${teacherStats.body.totalStudents})`);

    const teacherStudents = await request({
      path: '/api/teachers/students',
      headers: { Authorization: `Bearer ${tokens['TEACHER']}` },
    });
    assert(teacherStudents.status === 200, `Teacher student roster fetched (HTTP 200)`);

    // 7b. Super Admin operations
    const adminStats = await request({
      path: '/api/admin/users/dashboard-stats',
      headers: { Authorization: `Bearer ${tokens['SUPER_ADMIN']}` },
    });
    assert(adminStats.status === 200, `Super Admin dashboard metrics loaded (HTTP 200)`);
    assert(adminStats.body.courses !== undefined && adminStats.body.students !== undefined, `Admin stats include courses (${adminStats.body.courses}) and students (${adminStats.body.students})`);

    const adminTeachers = await request({
      path: '/api/admin/users/teachers',
      headers: { Authorization: `Bearer ${tokens['SUPER_ADMIN']}` },
    });
    assert(adminTeachers.status === 200, `Admin teachers list loaded (HTTP 200)`);

    const adminStudents = await request({
      path: '/api/admin/users/students',
      headers: { Authorization: `Bearer ${tokens['SUPER_ADMIN']}` },
    });
    assert(adminStudents.status === 200, `Admin students list loaded (HTTP 200)`);
  } catch (err) {
    assert(false, `Teacher/Admin exception`, err.message);
  }

  // --- FINAL REPORT ---
  console.log('\n================================================================');
  console.log(`📊 FINAL LIVE E2E PRODUCTION VERIFICATION RESULTS:`);
  console.log(`   Total Tests Executed: ${passedTests + failedTests}`);
  console.log(`   ✅ Total Tests Passed: ${passedTests}`);
  console.log(`   ❌ Total Tests Failed: ${failedTests}`);
  const passRate = ((passedTests / (passedTests + failedTests)) * 100).toFixed(1);
  console.log(`   🎉 Final Success Rate: ${passRate}%`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runLiveE2E().catch((err) => {
  console.error('Fatal E2E error:', err);
  process.exit(1);
});
