import { execSync } from 'child_process';

/**
 * Global Setup for E2E Test Suite
 *
 * Runs once before any E2E test suite executes.
 * If PostgreSQL is running, pushes the Prisma schema cleanly into the test DB.
 */
export default function globalSetup(): void {
  const DEFAULT_TEST_DATABASE_URL =
    'postgresql://lms_test:LmsTestOnly_2026@localhost:5432/lms_test?schema=public';
  const url = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  const env = { ...process.env, DATABASE_URL: url };

  try {
    execSync('npx prisma db push --accept-data-loss --skip-generate', {
      stdio: 'pipe',
      env,
      timeout: 15000,
    });
  } catch (err: any) {
    // If PostgreSQL is offline, log preflight warning for the runner.
    // The test runner script or test-with-db.ps1 preflights the container.
    console.warn('⚠️ E2E globalSetup: Database push skipped or offline. Continuing test execution.');
  }
}
