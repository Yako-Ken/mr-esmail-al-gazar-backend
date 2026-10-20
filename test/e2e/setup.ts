/**
 * E2E Test Suite Environment Setup
 *
 * Configures process.env for opaque-box E2E testing against the Express API.
 * Ensures strict PostgreSQL dialect, HMAC secrets, and isolated ports.
 */

const DEFAULT_TEST_DATABASE_URL =
  'postgresql://lms_test:LmsTestOnly_2026@localhost:5432/lms_test?schema=public';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production-use-01234';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
process.env.ALLOWED_ORIGINS = '*';
process.env.PORT = '5098';

// Paymob Webhook HMAC Secret
process.env.PAYMOB_HMAC_SECRET = 'test-only-paymob-hmac-secret-0123456789';

// FCM & Push Notifications
process.env.FCM_ENABLED = 'false';

// Bunny.net Stream and CDN Keys
process.env.BUNNY_STREAM_TOKEN_KEY = 'test-stream-token-key-123456';
process.env.BUNNY_STREAM_CDN_URL = 'https://stream.example.test';
process.env.BUNNY_CDN_TOKEN_KEY = 'test-bunny-cdn-token-key-123456';
process.env.BUNNY_CDN_URL = 'https://media.example.test';
