/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  globalSetup: '<rootDir>/test/globalSetup.ts',
  clearMocks: true,

  // Jest's 5 s default is too tight for this suite. These are integration tests
  // that perform real bcrypt work at cost 12 (250-400 ms per hash) and real
  // HTTP round-trips through the Express app, all against a live PostgreSQL.
  // A handful of cases legitimately need 15-30 s: password rate limiting fires
  // 14 sequential change-password requests, and fixture setup hashes passwords
  // in beforeAll hooks.
  //
  // Without this, the same code produced red builds that passed when run alone
  // and failed inside a full run — which is worse than a real failure, because
  // it teaches the team to ignore a red suite. This raises the harness budget to
  // match the work the tests actually do; it does not loosen any assertion, and
  // it does not skip anything.
  //
  // Note: `hookTimeout` is not a valid option in this Jest version and was
  // removed — it produced a "Unknown option" validation warning on every run.
  testTimeout: 30_000,

  // Suites run one at a time, deliberately.
  //
  // These are integration tests: each one creates real users, courses, lessons
  // and enrollments, then deletes them in afterAll. Jest's default is parallel
  // workers against one shared PostgreSQL, so suites were corrupting each
  // other's fixtures mid-run — the same code produced 68 failures in one run and
  // 14 in the next, with every suite green in isolation. Two further problems
  // fed the same illusion:
  //
  //   - 52 separate `new PrismaClient()` call sites, each with its own pool,
  //     exhausted `max_connections` and failed with "too many clients already".
  //     That is fixed at the source in src/config/prisma.ts (one shared client).
  //   - overlapping phone-number fixtures let two suites own the same user rows.
  //     Each suite now owns a disjoint range.
  //
  // Serial execution is slower and boring, which is the point: a green suite
  // has to mean the product works, not that the fixtures happened not to collide.
  maxWorkers: 1,
};