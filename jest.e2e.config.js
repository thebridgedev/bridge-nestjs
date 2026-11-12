/**
 * The demo app end to end (e2e/*.e2e.spec.ts), on the plugin's source.
 *
 *   npm run e2e:test                                   against a signing issuer in memory
 *   E2E_ISSUER=https://…/identity-access/apps/<app id> npm run e2e:test   also against a real issuer
 *
 * Packages resolve from bridge-nestjs/node_modules: install there first.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/e2e'],
  testMatch: ['**/*.e2e.spec.ts'],
  testTimeout: 30000,
  maxWorkers: 1,
  transform: {
    '^.+\\.[jt]sx?$': ['<rootDir>/bridge-nestjs/node_modules/ts-jest', { useESM: false, tsconfig: '<rootDir>/tsconfig.e2e.json' }],
  },
  transformIgnorePatterns: ['node_modules/(?!.*(@nebulr-group[+/]bridge-auth-core|jose[@/]))'],
  moduleDirectories: ['node_modules', '<rootDir>/bridge-nestjs/node_modules'],
  moduleNameMapper: {
    '^@nebulr-group/bridge-nestjs$': '<rootDir>/bridge-nestjs/src',
    '^@nebulr-group/bridge-auth-core/(.*)\\.js$': '@nebulr-group/bridge-auth-core/$1',
  },
};
