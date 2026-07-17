import { execSync } from 'child_process';

// Runs once before the whole test run: pushes the current schema to a
// throwaway SQLite file so integration tests never touch prisma/dev.db.
export default function globalSetup(): void {
  execSync('npx prisma db push --accept-data-loss --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
  });
}
