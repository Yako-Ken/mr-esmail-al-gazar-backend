import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

// Ensure test database URL with pool limits
const DEFAULT_TEST_DATABASE_URL =
  'postgresql://lms_test:LmsTestOnly_2026@localhost:5432/lms_test?schema=public&connection_limit=20&pool_timeout=30';

let dbUrl = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
if (!dbUrl.includes('connection_limit')) {
  dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'connection_limit=20&pool_timeout=30';
}
process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'test';

import prisma from '../src/config/prisma';

interface PgStatRow {
  count: bigint;
  state: string | null;
}

async function getPgConnectionStats(): Promise<{ total: number; states: Record<string, number> }> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint; state: string | null }>>(
    `SELECT count(*)::bigint as count, state FROM pg_stat_activity WHERE datname = 'lms_test' GROUP BY state;`
  );
  let total = 0;
  const states: Record<string, number> = {};
  for (const r of rows) {
    const c = Number(r.count);
    total += c;
    states[r.state || 'unknown'] = c;
  }
  return { total, states };
}

async function runPoolStressTests() {
  console.log('=== EMPIRICAL STRESS TEST: PostgreSQL Connection Pool ===');
  console.log(`Target URL: ${dbUrl.replace(/:[^:@]+@/, ':***@')}`);

  // Step 1: Baseline connections
  const baseline = await getPgConnectionStats();
  console.log(`[Baseline] Total DB connections: ${baseline.total}, states: ${JSON.stringify(baseline.states)}`);

  // Step 2: Concurrency spike test (60 simultaneous queries, pool limit is 20)
  console.log('\n--- Test 1: Concurrency Spike (60 simultaneous queries, pool=20) ---');
  const spikeCount = 60;
  const spikeStart = Date.now();
  const spikePromises = Array.from({ length: spikeCount }, async (_, i) => {
    const t0 = Date.now();
    const result = await prisma.$queryRawUnsafe<{ res: number }[]>(`SELECT ${i} as res;`);
    const duration = Date.now() - t0;
    return { i, duration, result: result[0]?.res };
  });

  const spikeResults = await Promise.all(spikePromises);
  const spikeDuration = Date.now() - spikeStart;
  const spikeFailures = spikeResults.filter((r) => r.result === undefined);
  const durations = spikeResults.map((r) => r.duration).sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const p99 = durations[Math.floor(durations.length * 0.99)];

  console.log(`Spike completed in ${spikeDuration} ms`);
  console.log(`Total queries: ${spikeCount}, Failures: ${spikeFailures.length}`);
  console.log(`Latencies: min=${durations[0]}ms, p50=${p50}ms, p95=${p95}ms, p99=${p99}ms, max=${durations[durations.length - 1]}ms`);
  if (spikeFailures.length > 0) {
    throw new Error(`Spike test had ${spikeFailures.length} failed queries!`);
  }

  // Step 3: Rapid successive queries under 25 concurrent workers (total 1000 queries)
  console.log('\n--- Test 2: Rapid Successive Batched Queries (25 workers x 40 queries = 1,000 queries) ---');
  const workerCount = 25;
  const queriesPerWorker = 40;
  const rapidStart = Date.now();

  const workerPromises = Array.from({ length: workerCount }, async (workerId) => {
    const workerLatencies: number[] = [];
    for (let q = 0; q < queriesPerWorker; q++) {
      const t0 = Date.now();
      const res = await prisma.user.count();
      workerLatencies.push(Date.now() - t0);
    }
    return workerLatencies;
  });

  const allWorkerLatencies = await Promise.all(workerPromises);
  const rapidDuration = Date.now() - rapidStart;
  const flatLatencies = allWorkerLatencies.flat().sort((a, b) => a - b);
  const totalQueries = flatLatencies.length;
  const qps = (totalQueries / (rapidDuration / 1000)).toFixed(1);

  console.log(`Executed ${totalQueries} queries across ${workerCount} concurrent workers in ${rapidDuration} ms (~${qps} QPS)`);
  console.log(`Latencies: min=${flatLatencies[0]}ms, p50=${flatLatencies[Math.floor(totalQueries * 0.5)]}ms, p95=${flatLatencies[Math.floor(totalQueries * 0.95)]}ms, max=${flatLatencies[totalQueries - 1]}ms`);

  // Step 4: Slow query queueing and pool timeout resilience (30 concurrent sleep queries)
  console.log('\n--- Test 3: Pool Queueing Resilience (30 concurrent 200ms sleep queries, pool=20) ---');
  const sleepStart = Date.now();
  const sleepPromises = Array.from({ length: 30 }, async (_, i) => {
    const t0 = Date.now();
    await prisma.$queryRawUnsafe(`SELECT pg_sleep(0.2)::text;`);
    return Date.now() - t0;
  });

  const sleepDurations = await Promise.all(sleepPromises);
  const sleepTotalDuration = Date.now() - sleepStart;
  console.log(`30 queries (200ms each) completed in ${sleepTotalDuration} ms across pool of 20`);
  // With pool of 20, 20 queries run simultaneously in ~200ms, and remaining 10 run in next batch ~200ms.
  // Expected total time: between 300ms and 800ms.
  console.log(`Execution was properly serialized/batched by pool: ${sleepTotalDuration >= 350 ? 'YES' : 'NO'}`);

  // Step 5: High-concurrency Transaction Stress Test
  console.log('\n--- Test 4: High-concurrency Transaction Stress (30 parallel interactive transactions) ---');
  const txStart = Date.now();
  const txPromises = Array.from({ length: 30 }, async (_, i) => {
    return prisma.$transaction(async (tx) => {
      const count = await tx.user.count();
      const courses = await tx.course.count();
      return { count, courses };
    });
  });

  const txResults = await Promise.all(txPromises);
  const txDuration = Date.now() - txStart;
  console.log(`30 transactions completed successfully in ${txDuration} ms. Success count: ${txResults.length}`);

  // Step 6: Post-stress connection leak and state verification
  console.log('\n--- Test 5: Post-Stress Connection Leak Check ---');
  // Allow a moment for active queries to settle to idle
  await new Promise((resolve) => setTimeout(resolve, 500));
  const postStats = await getPgConnectionStats();
  console.log(`[Post-Test] Total DB connections: ${postStats.total}, states: ${JSON.stringify(postStats.states)}`);

  const idleInTx = postStats.states['idle in transaction'] || 0;
  if (idleInTx > 0) {
    throw new Error(`LEAK DETECTED: Found ${idleInTx} connections in 'idle in transaction'!`);
  }

  // Verify connection pool doesn't exceed pool limit + margin
  // connection_limit is 20, so active + idle client connections for lms_test should not exceed 25.
  if (postStats.total > 25) {
    throw new Error(`CONNECTION SPIKE: Total connections on lms_test (${postStats.total}) exceeds pool limit 20 significantly!`);
  }

  console.log('\n✅ ALL POOL STRESS TESTS PASSED WITHOUT ERRORS OR LEAKS.');
}

runPoolStressTests()
  .catch((err) => {
    console.error('❌ STRESS TEST FAILED:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log('Client successfully disconnected from PostgreSQL.');
  });
