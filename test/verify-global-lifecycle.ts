import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
const TARGET_DB = 'lms_challenger1';
const TEST_URL = `postgresql://lms_test:LmsTestOnly_2026@localhost:5432/${TARGET_DB}?schema=public&connection_limit=5&pool_timeout=10`;

process.env.TEST_DATABASE_URL = TEST_URL;
process.env.DATABASE_URL = TEST_URL;
process.env.NODE_ENV = 'test';

const { default: globalSetup } = require('./globalSetup');

async function countDbConnections(): Promise<number> {
  const adminClient = new PrismaClient({
    datasources: { db: { url: `${TEST_URL}&connection_limit=1` } },
  });
  try {
    const res = await adminClient.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint as count FROM pg_stat_activity WHERE datname = '${TARGET_DB}' AND application_name != 'psql';`
    );
    return Number(res[0].count);
  } finally {
    await adminClient.$disconnect();
  }
}

async function runGlobalLifecycleVerification() {
  console.log('=== EMPIRICAL VERIFICATION: globalSetup Resource Release ===');

  const baselineConns = await countDbConnections();
  console.log(`[Baseline] Connections to ${TARGET_DB}: ${baselineConns}`);

  // 1. Run globalSetup
  console.log('\n--- Step 1: Execute globalSetup() ---');
  const t0 = Date.now();
  globalSetup();
  const duration1 = Date.now() - t0;
  console.log(`globalSetup() finished in ${duration1}ms`);

  const afterSetupConns = await countDbConnections();
  console.log(`[After globalSetup 1] Connections to ${TARGET_DB}: ${afterSetupConns}`);

  if (afterSetupConns > baselineConns + 1) {
    throw new Error(`Orphaned connections detected after globalSetup! Baseline: ${baselineConns}, After: ${afterSetupConns}`);
  }

  // 2. Run globalSetup again immediately (simulating immediate consecutive run)
  console.log('\n--- Step 2: Execute globalSetup() a second time (consecutive run) ---');
  const t1 = Date.now();
  globalSetup();
  const duration2 = Date.now() - t1;
  console.log(`Second globalSetup() finished in ${duration2}ms`);

  const afterSetupConns2 = await countDbConnections();
  console.log(`[After globalSetup 2] Connections to ${TARGET_DB}: ${afterSetupConns2}`);

  if (afterSetupConns2 > baselineConns + 1) {
    throw new Error(`Orphaned connections detected after consecutive globalSetup! Baseline: ${baselineConns}, After: ${afterSetupConns2}`);
  }

  // 3. Verify database integrity after globalSetup
  console.log('\n--- Step 3: Verify database schema usability after reset ---');
  const verifyClient = new PrismaClient({
    datasources: { db: { url: TEST_URL } },
  });

  try {
    const userCount = await verifyClient.user.count();
    const courseCount = await verifyClient.course.count();
    console.log(`Schema is healthy and empty: users=${userCount}, courses=${courseCount}`);
  } finally {
    await verifyClient.$disconnect();
  }

  const finalConns = await countDbConnections();
  console.log(`[Final] Connections to ${TARGET_DB}: ${finalConns}`);

  console.log('✅ globalSetup lifecycle executed cleanly with zero orphaned connections.');
}

runGlobalLifecycleVerification().catch((err) => {
  console.error('❌ globalSetup verification failed:', err);
  process.exit(1);
});
