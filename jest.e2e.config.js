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

  // auth-core (and its `jose` dependency) are published as native ESM, and the
  // plugin reaches both transitively. Jest's CJS runner needs the same three
  // adjustments the unit config (bridge-nestjs/jest.config.js) already makes,
  // otherwise every suite dies at module-load with
  // `SyntaxError: Unexpected token 'export'`:
  //   1. transform `.js`/`.mjs` too — the ts-jest preset only registers .ts/.tsx
  //   2. un-ignore those packages in node_modules
  //   3. strip NodeNext `.js` suffixes from auth-core's internal subpath imports
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.e2e.json',
      },
    ],
    // Scoped to node_modules so the project's own CommonJS `.js` files (the
    // global-setup/teardown wrappers, the plugin's built dist) are left alone —
    // running them through ts-jest works but emits an `allowJs` warning per file.
    'node_modules[\\\\/].+\\.m?js$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.e2e.json',
        isolatedModules: true,
      },
    ],
  },

  // Bun's isolated installs place packages under
  //   node_modules/.bun/<name>@<ver>/node_modules/<name>/…
  // so a pattern anchored on `node_modules/@nebulr-group/…` would never match.
  // The `[+/]` covers bun's `+` encoding of the scope separator.
  transformIgnorePatterns: [
    'node_modules/(?!.*(@nebulr-group[+/]bridge-auth-core|jose[@/]))',
  ],

  moduleNameMapper: {
    '^@nebulr-group/bridge-auth-core/(.*)\\.js$':
      '@nebulr-group/bridge-auth-core/$1',
  },

  // E2E tests are slower than unit tests — allow up to 30s per test
  testTimeout: 30000,

  // Run suites sequentially to avoid competing for the same test accounts
  maxWorkers: 1,
};
