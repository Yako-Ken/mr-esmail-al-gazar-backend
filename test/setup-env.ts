// Runs before each test file loads. Values here must satisfy src/utils/env.ts's
// zod schema, since importing src/app.ts (directly or via a service) triggers
// that validation and calls process.exit(1) on failure.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production-use-01234';
process.env.DATABASE_URL = 'file:./test.db';
process.env.ALLOWED_ORIGINS = '*';
process.env.PORT = '5099';
