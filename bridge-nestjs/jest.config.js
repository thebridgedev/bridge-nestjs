/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/index.ts'],
  // Phase 6 (TBP-290/340) — auth-core is published as native ESM
  // (`"type": "module"` + `"module": "ESNext"`). Three changes make Jest's
  // CJS runner load it without switching this whole project to ESM:
  //
  //   1. `transformIgnorePatterns` whitelists `@nebulr-group/bridge-auth-core`
  //      so Jest stops skipping it in node_modules.
  //   2. `transform` extends ts-jest to also handle `.js` (and `.mjs`)
  //      files — the preset only registers `.ts/.tsx` by default, which is
  //      why the whitelist alone isn't enough.
  //   3. `moduleNameMapper` strips `.js` suffixes from auth-core's NodeNext
  //      internal subpath imports so Jest's resolver can find them.
  //
  // Without #2, every spec that imports anything reaching into auth-core
  // fails at module-load with `SyntaxError: Unexpected token 'export'`.
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', { useESM: false, isolatedModules: true }],
  },
  // Matches the package wherever it resolves, not just directly under a flat
  // `node_modules/`. Bun's isolated installs place it at
  //   node_modules/.bun/@nebulr-group+bridge-auth-core@<ver>/node_modules/@nebulr-group/bridge-auth-core/…
  // so a pattern anchored on `node_modules/@nebulr-group/…` sees `.bun` right
  // after the first `node_modules/`, fails the lookahead, and silently skips
  // transforming auth-core — every spec reaching into it then dies with
  // `SyntaxError: Unexpected token 'export'`. The `[+/]` covers bun's `+`
  // encoding of the scope separator in that directory name.
  // `jose` is listed too: it is native ESM and reached transitively through
  // auth-core's backend verifier, so whitelisting auth-core alone just moves
  // the `Unexpected token 'export'` one level down the import chain.
  transformIgnorePatterns: [
    'node_modules/(?!.*(@nebulr-group[+/]bridge-auth-core|jose[@/]))',
  ],
  moduleNameMapper: {
    '^@nebulr-group/bridge-auth-core/(.*)\\.js$': '@nebulr-group/bridge-auth-core/$1',
  },
};
