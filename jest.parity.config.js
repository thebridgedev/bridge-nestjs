/**
 * The stage parity suite (e2e/parity/*.parity.spec.ts): the demo app against a real test app on a deployment of the
 * new Bridge. Skipped unless PARITY_ISSUER and PARITY_APP_KEY are set; see e2e/parity/README.md.
 */
const base = require('./jest.e2e.config.js');
module.exports = { ...base, testMatch: ['**/*.parity.spec.ts'], testTimeout: 120000 };
