/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  rootDir: '../..',
  testMatch: ['<rootDir>/test/e2e/**/*.e2e.test.ts'],
  setupFiles: ['<rootDir>/test/e2e/setup.ts'],
  globalSetup: '<rootDir>/test/e2e/globalSetup.ts',
  clearMocks: true,
  testTimeout: 30000,
  maxWorkers: 1,
};
