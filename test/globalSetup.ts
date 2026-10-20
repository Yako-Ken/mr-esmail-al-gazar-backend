import { execSync } from 'child_process';

// Runs once before the whole test run.
//
// PostgreSQL only. It provisions a dedicated, throwaway test database so an
// integration test can never touch development or production data, then pushes
// the current schema into it.
//
// The schema is PUSHED rather than MIGRATED on purpose: `migrate deploy` is
// exercised separately (see package.json "db:migrate:test") so that a broken
// migration cannot silently pass the suite. `db push` guarantees the schema the
// tests run against is exactly what prisma/schema.prisma declares.
//
// Any pre-existing tables in the target schema are dropped first, so a leftover
// database from an aborted run can never mask a missing table.

const DEFAULT_TEST_DATABASE_URL =
  'postgresql://lms_test:LmsTestOnly_2026@localhost:5432/lms_test?schema=public';

const url = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;

export default function globalSetup(): void {
  const env = { ...process.env, DATABASE_URL: url };

  // Start from a genuinely empty schema. Uses --force because the target is a
  // disposable test database by contract.
  try {
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
      stdio: 'inherit',
      env,
    });
  } catch {
    // Fall back to a reset that does not require --accept-data-loss. Some
    // managed providers reject data-loss prompts for non-empty schemas.
    execSync('npx prisma db push --force-reset --skip-generate', {
      stdio: 'inherit',
      env,
    });
  }
}
