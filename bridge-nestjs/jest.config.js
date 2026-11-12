/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/index.ts'],
  // auth-core and jose are native ESM. Jest's CommonJS runner loads them once
  // ts-jest transforms their `.js` files too, they are not skipped in
  // node_modules (any install layout, including bun's `.bun/<name>@<ver>`),
  // and auth-core's internal `.js` subpath imports resolve.
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', { useESM: false, tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  transformIgnorePatterns: ['node_modules/(?!.*(@nebulr-group[+/]bridge-auth-core|jose[@/]))'],
  moduleNameMapper: {
    '^@nebulr-group/bridge-auth-core/(.*)\\.js$': '@nebulr-group/bridge-auth-core/$1',
  },
};
