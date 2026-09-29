import { test, expect } from '../demo-kit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * TBP-540 (milestone TBP-M35): a route rule written without the app's global
 * prefix says which path to write, and `@Public()` avoids the question.
 *
 * In the owner's NestJS 12 run, `app.setGlobalPrefix('api')` plus a rule
 * `{ path: '/health', privilege: 'ANONYMOUS' }` left the health check
 * answering 401 with nothing saying why: rules match the full request path.
 * With @nebulr-group/bridge-nestjs 0.8.0-beta.3 the first request that would
 * have matched without its prefix logs, once, the path to write
 * (`/api/health`). Putting `@Public()` on the handler instead makes it answer
 * 200 wherever it is mounted.
 *
 * A small Nest 12 app (plain JS, no build step) runs in a throwaway node:24
 * container; the guard needs no network for these requests. Nothing on stage
 * is touched. Containers and the scratch project are removed at the end
 * (memory preflight first).
 *
 * Re-run:
 *   ~/Workflows/bin/run-demo.sh TBP-540 bridge-plugins/bridge-nestjs/demos/a-rule-missing-the-global-prefix-says-what-to-write.demo.ts
 */

const NESTJS_PLUGIN_VERSION = process.env.DEMO_NESTJS_VERSION ?? '0.8.0-beta.3';
const CONTAINER = 'demo-nest-prefix-rule';
const PORT = 3398;

const MAIN = `// main.js: a NestJS 12 app with a global prefix and the Bridge guard
require('reflect-metadata');
const { Module, Controller, Get } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { BridgeModule, Public } = require('@nebulr-group/bridge-nestjs');

class HealthController {
  health() { return { ok: true }; }
}
const d = Object.getOwnPropertyDescriptor(HealthController.prototype, 'health');
Get('health')(HealthController.prototype, 'health', d);
if (process.env.USE_PUBLIC) Public()(HealthController.prototype, 'health', d); // @Public()
Controller()(HealthController);

class AppModule {}
Module({
  imports: [
    BridgeModule.forRoot({
      appId: 'demo-app',
      guard: {
        global: true,
        defaultAccess: 'protected',
        rules: [{ path: '/health', privilege: 'ANONYMOUS' }],
      },
    }),
  ],
  controllers: [HealthController],
})(AppModule);

(async () => {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.setGlobalPrefix('api');
  await app.listen(3000);
})();
`;

test('A route rule that misses the global prefix says which path to write', async ({ demo }) => {
	test.setTimeout(10 * 60 * 1000);
	const { step, terminal } = demo;
	const dir = mkdtempSync(join(tmpdir(), 'api-'));
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify(
			{
				name: 'api',
				private: true,
				dependencies: {
					'@nebulr-group/bridge-nestjs': NESTJS_PLUGIN_VERSION,
					'@nestjs/common': '^12',
					'@nestjs/core': '^12',
					'@nestjs/platform-express': '^12',
					'reflect-metadata': '^0.2.2',
					rxjs: '^7.8.2'
				}
			},
			null,
			2
		)
	);
	writeFileSync(join(dir, 'main.js'), MAIN);
	const at = { cwd: dir, promptDir: 'api', title: 'api — a NestJS 12 app', timeoutMs: 300_000 };
	const start = (env = '') =>
		`docker rm -f ${CONTAINER} >/dev/null 2>&1; docker run -d --rm --name ${CONTAINER} ${env} -p ${PORT}:3000 -v "${dir}":/w -w /w node:24 node main.js >/dev/null ` +
		`&& for i in $(seq 1 30); do curl -s -o /dev/null localhost:${PORT}/api/health && break; sleep 1; done`;

	try {
		await step('The app mounts everything under /api, and a Bridge rule makes /health public', async () => {
			const { output } = await terminal(`grep -n -e setGlobalPrefix -e "rules:" main.js`, { ...at, clear: true });
			expect(output).toContain("setGlobalPrefix('api')");
			expect(output).toContain("{ path: '/health', privilege: 'ANONYMOUS' }");
			await terminal(
				`set -o pipefail; docker run --rm -v "${dir}":/w -w /w -e NPM_CONFIG_UPDATE_NOTIFIER=false -e NPM_CONFIG_FUND=false -e NPM_CONFIG_AUDIT=false node:24 npm install 2>&1 | tail -1`,
				{ ...at, shown: `npm install   # @nebulr-group/bridge-nestjs@${NESTJS_PLUGIN_VERSION}, NestJS 12` }
			);
		});

		await step('The health check still answers 401: the request path is /api/health, and the rule says /health', async () => {
			const { output } = await terminal(`${start()} && curl -s -w '  (HTTP %{http_code})\\n' localhost:${PORT}/api/health`, {
				...at,
				clear: true,
				shown: `node main.js &  curl localhost:3000/api/health`
			});
			expect(output).toContain('HTTP 401');
		});

		await step('The app’s log now says why, once, and which path to write: /api/health, or @Public() on the handler', async () => {
			const { output } = await terminal(`docker logs ${CONTAINER} 2>&1 | grep bridge-nestjs | fold -s -w 116`, { ...at, shown: 'node main.js   # the server log' });
			expect(output).toContain("write '/api/health'");
			expect(output).toContain('@Public()');
		});

		await step('With @Public() on the handler, the health check answers 200, prefix or not', async () => {
			const { output } = await terminal(`${start('-e USE_PUBLIC=1')} && curl -s -w '  (HTTP %{http_code})\\n' localhost:${PORT}/api/health`, {
				...at,
				clear: true,
				shown: `node main.js &  curl localhost:3000/api/health   # health() now carries @Public()`
			});
			expect(output).toContain('HTTP 200');
		});
	} finally {
		execSync(`docker rm -f ${CONTAINER} >/dev/null 2>&1 || true`);
		execSync(`docker run --rm -v "${dir}":/w node:24 rm -rf /w/node_modules >/dev/null 2>&1 || true`);
		rmSync(dir, { recursive: true, force: true });
	}
});
