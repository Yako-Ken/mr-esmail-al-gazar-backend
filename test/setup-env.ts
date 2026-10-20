// Runs before each test file loads. Values here must satisfy src/utils/env.ts's
// zod schema, since importing src/app.ts (directly or via a service) triggers
// that validation and calls process.exit(1) on failure.
//
// PostgreSQL only. The product runs on PostgreSQL, so tests must exercise the
// same engine — SQLite accepts types and NULLs that PostgreSQL rejects, so a
// SQLite-only suite would hide real production failures.
//
// Override the target with TEST_DATABASE_URL when running against a dedicated
// disposable database; otherwise it defaults to localhost/lms_test, matching
// the local Docker container used for development.
const DEFAULT_TEST_DATABASE_URL =
  'postgresql://lms_test:LmsTestOnly_2026@localhost:5432/lms_test?schema=public&connection_limit=20&pool_timeout=30';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production-use-01234';
let dbUrl = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
if (!dbUrl.includes('connection_limit')) {
  dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'connection_limit=20&pool_timeout=30';
}
process.env.DATABASE_URL = dbUrl;
process.env.ALLOWED_ORIGINS = '*';
process.env.PORT = '5099';

// The Paymob webhook is the authority that turns money into course access, so
// it must be exercised rather than left to fail closed. This is a throwaway
// test-only secret; the provider is never actually contacted.
process.env.PAYMOB_HMAC_SECRET = 'test-only-paymob-hmac-secret-0123456789';
process.env.FCM_ENABLED = 'false';
