import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://lms_test:LmsTestOnly_2026@localhost:5432/lms_test?schema=public';

// Helper to get raw connection counts from postgres
async function getRawPostgresConnections(): Promise<number> {
  const adminClient = new PrismaClient({
    datasources: { db: { url: `${BASE_URL}&connection_limit=1` } },
  });
  try {
    const res = await adminClient.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint as count FROM pg_stat_activity WHERE datname = 'lms_test' AND application_name != 'psql';`
    );
    return Number(res[0].count);
  } finally {
    await adminClient.$disconnect();
  }
}

async function testAdversarialScenarios() {
  console.log('=== ADVERSARIAL STRESS TEST: Connection Pool Faults & Recovery ===');

  const initialCount = await getRawPostgresConnections();
  console.log(`[Initial] Active non-psql connections to lms_test: ${initialCount}`);

  // Test 1: Pool Timeout & Graceful Error Handling + Immediate Recovery
  console.log('\n--- Scenario 1: Pool Starvation Timeout & Immediate Recovery ---');
  // Configure client with tiny pool limit = 2 and short timeout = 2 seconds
  const starvedUrl = `${BASE_URL}&connection_limit=2&pool_timeout=2`;
  const starvedClient = new PrismaClient({
    datasources: { db: { url: starvedUrl } },
  });

  try {
    // Occupy both 2 connections with 3-second sleep queries eagerly
    const blocker1 = (async () => starvedClient.$queryRawUnsafe(`SELECT pg_sleep(3)::text;`))();
    const blocker2 = (async () => starvedClient.$queryRawUnsafe(`SELECT pg_sleep(3)::text;`))();

    // Give them 100ms to claim the 2 pool slots
    await new Promise((r) => setTimeout(r, 100));

    // Check pg_stat_activity directly
    const checkClient = new PrismaClient({ datasources: { db: { url: `${BASE_URL}&connection_limit=1` } } });
    const activeQueries = await checkClient.$queryRawUnsafe<any[]>(
      `SELECT pid, state, query FROM pg_stat_activity WHERE datname = 'lms_test' AND query LIKE '%pg_sleep%';`
    );
    console.log(`Active pg_sleep queries found in postgres: ${activeQueries.length}`, activeQueries);
    const allConns = await checkClient.$queryRawUnsafe<any[]>(
      `SELECT pid, state, query FROM pg_stat_activity WHERE datname = 'lms_test';`
    );
    console.log(`All connections to lms_test (${allConns.length}):`, allConns.map(c => ({ pid: c.pid, state: c.state, query: c.query.slice(0, 40) })));
    await checkClient.$disconnect();

    // Try a 3rd query: pool has no available slots and timeout is 2s, blockers take 3s.
    // This MUST trigger pool timeout error P2024.
    let timedOut = false;
    let errorCode = '';
    const t0 = Date.now();
    let query3Duration = 0;
    try {
      await starvedClient.user.count();
      query3Duration = Date.now() - t0;
      console.log(`Query 3 completed in ${query3Duration}ms`);
    } catch (err: any) {
      timedOut = true;
      query3Duration = Date.now() - t0;
      errorCode = err.code || err.message;
      console.log(`Expected pool exhaustion error caught in ${query3Duration}ms: code=${err.code}, message=${err.message.split('\n')[0]}`);
    }

    if (!timedOut) {
      console.log(`Query 3 finished in ${query3Duration}ms without error.`);
      throw new Error(`Expected query to time out waiting for connection pool, but it succeeded in ${query3Duration}ms!`);
    }

    // Wait for blockers to finish
    await Promise.all([blocker1, blocker2]);

    // Now test recovery: after blockers release their slots, can starvedClient execute queries again?
    const recoveryStart = Date.now();
    const count = await starvedClient.user.count();
    const recoveryTime = Date.now() - recoveryStart;
    console.log(`Pool recovered successfully after starvation! Query returned count=${count} in ${recoveryTime}ms`);
  } finally {
    await starvedClient.$disconnect();
  }

  // Test 2: Rapid Disconnect & Reconnect Cycling
  console.log('\n--- Scenario 2: Rapid PrismaClient Instance Creation & Teardown Cycling ---');
  // Simulates what happens if tests or rogue modules create and destroy clients
  const cycleCount = 10;
  for (let c = 0; c < cycleCount; c++) {
    const client = new PrismaClient({
      datasources: { db: { url: `${BASE_URL}&connection_limit=5` } },
    });
    await client.$queryRawUnsafe('SELECT 1 as num;');
    await client.$disconnect();
  }
  console.log(`Completed ${cycleCount} sequential client open-query-disconnect cycles.`);

  // Test 3: Massive 200-Query Concurrency Wave on Default Pool
  console.log('\n--- Scenario 3: Massive 200-Query Concurrency Wave on Default Pool (limit=20) ---');
  const mainClient = new PrismaClient({
    datasources: { db: { url: `${BASE_URL}&connection_limit=20&pool_timeout=30` } },
  });

  const waveCount = 200;
  const waveStart = Date.now();
  const wavePromises = Array.from({ length: waveCount }, async (_, i) => {
    return mainClient.$queryRawUnsafe(`SELECT ${i}::int as id;`);
  });

  const waveResults = await Promise.all(wavePromises);
  const waveDuration = Date.now() - waveStart;
  console.log(`Dispatched ${waveCount} simultaneous queries. Completed in ${waveDuration}ms. Success: ${waveResults.length}/${waveCount}`);

  if (waveResults.length !== waveCount) {
    throw new Error(`Wave query count mismatch: expected ${waveCount}, got ${waveResults.length}`);
  }

  await mainClient.$disconnect();

  // Test 4: Final Leak Verification
  console.log('\n--- Scenario 4: Final Leak Verification ---');
  await new Promise((r) => setTimeout(r, 600));
  const finalCount = await getRawPostgresConnections();
  console.log(`[Final] Active non-psql connections to lms_test: ${finalCount} (initial was ${initialCount})`);

  // Allow margin of +1 for adminClient itself during check
  if (finalCount > initialCount + 1) {
    throw new Error(`Connection leak detected! Initial: ${initialCount}, Final: ${finalCount}`);
  }

  console.log('✅ ALL ADVERSARIAL POOL SCENARIOS PASSED WITH PERFECT ISOLATION & CLEAN TEARDOWN.');
}

testAdversarialScenarios()
  .catch((e) => {
    console.error('❌ ADVERSARIAL TEST FAILED:', e);
    process.exit(1);
  });
