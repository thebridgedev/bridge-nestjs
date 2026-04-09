/**
 * Jest configuration for E2E integration tests.
 *
 * Runs against a real Bridge API (local or stage) using real JWT tokens.
 * Requires the demo AppModule — ensure bridge-nestjs is built first:
 *   npm run build && npm run e2e:setup && npm run e2e:test
 *
 * This config is separate from jest.config.js (unit tests) to avoid
 * accidentally running E2E tests in the normal test suite.
 */

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // Only look for e2e specs
  roots: ['<rootDir>/e2e/tests'],
  testMatch: ['**/*.e2e.spec.ts'],

  // Load .env.test.local into process.env before any test files run
  setupFiles: ['<rootDir>/e2e/load-test-env.ts'],

  // Run once before / after all suites (separate process).
  // JS wrappers register ts-node so the TypeScript source can be loaded.
  globalSetup: '<rootDir>/e2e/global-setup.js',
  globalTeardown: '<rootDir>/e2e/global-teardown.js',

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.e2e.json',
      },
    ],
  },

  // E2E tests are slower than unit tests — allow up to 30s per test
  testTimeout: 30000,

  // Run suites sequentially to avoid competing for the same test accounts
  maxWorkers: 1,
};
