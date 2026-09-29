import { test, expect } from '../demo-kit';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * TBP-760 (milestone TBP-M35): the plugin installs on a fresh NestJS 12 app
 * with a plain `npm i`, no flags.
 *
 * In a clean node:24 container (node:22's npm 10.9 fails on the bare Nest 12
 * scaffold itself, before Bridge is involved), `nest new` scaffolds an app
 * with the latest Nest CLI, which is NestJS 12, and the published beta of
 * @nebulr-group/bridge-nestjs installs into it with no --legacy-peer-deps or
 * --force. auth-core comes with it.
 *
 * Nothing on stage is touched. One container runs the whole demo and is
 * removed at the end, with the scratch project (memory preflight first).
 *
 * Re-run:
 *   ~/Workflows/bin/run-demo.sh TBP-760 bridge-plugins/bridge-nestjs/demos/installs-on-a-fresh-nestjs-12-app.demo.ts
 */

const NESTJS_PLUGIN_VERSION = process.env.DEMO_NESTJS_VERSION ?? '0.8.0-beta.3';
const CONTAINER = 'demo-nest12-install';

test('The Bridge plugin installs on a fresh NestJS 12 app, with no flags', async ({ demo }) => {
	test.setTimeout(12 * 60 * 1000);
	const { step, terminal } = demo;
	const dir = mkdtempSync(join(tmpdir(), 'nest12-'));
	const at = { cwd: dir, promptDir: '~', title: 'a clean machine — node 24', timeoutMs: 480_000 };
	const inBox = (cmd: string) => `docker exec -w /w ${CONTAINER} sh -c '${cmd.replace(/'/g, `'"'"'`)}'`;

	execSync(`docker rm -f ${CONTAINER} >/dev/null 2>&1 || true`);
	execSync(
		`docker run -d --rm --name ${CONTAINER} -v "${dir}":/w -w /w -e NPM_CONFIG_UPDATE_NOTIFIER=false -e NPM_CONFIG_FUND=false -e NPM_CONFIG_AUDIT=false node:24 sleep infinity >/dev/null`
	);
	try {
		await step('A new NestJS app, scaffolded with the latest Nest command line', async () => {
			const { output } = await terminal(
				inBox('node --version && npx -y @nestjs/cli@latest new api --package-manager npm --skip-git 2>&1 | sed "s/\\x1b\\[[0-9;]*[a-zA-Z]//g" | grep -E "CREATE api/package.json|Successfully|Installation in progress|ERR" | head -5'),
				{ ...at, clear: true, shown: 'node --version && npx @nestjs/cli@latest new api --package-manager npm --skip-git' }
			);
			expect(output).toMatch(/v24\./);
			expect(output).not.toContain('ERR');
		});

		await step('It is NestJS 12', async () => {
			const { output } = await terminal(inBox('cd api && npm ls @nestjs/core @nestjs/common'), { ...at, promptDir: 'api', shown: 'npm ls @nestjs/core @nestjs/common' });
			expect(output).toMatch(/@nestjs\/core@12\./);
		});

		await step('The Bridge plugin installs with a plain npm i: no --legacy-peer-deps, no --force, no peer warnings to clear up', async () => {
			const { output } = await terminal(inBox(`cd api && npm i @nebulr-group/bridge-nestjs@${NESTJS_PLUGIN_VERSION} 2>&1; echo "exit code: $?"`), {
				...at,
				promptDir: 'api',
				shown: `npm i @nebulr-group/bridge-nestjs@${NESTJS_PLUGIN_VERSION}; echo "exit code: $?"`
			});
			expect(output).toContain('exit code: 0');
			expect(output).not.toContain('ERESOLVE');
		});

		await step('The plugin and the auth-core it brings along are in the app, next to NestJS 12', async () => {
			const { output } = await terminal(inBox('cd api && npm ls @nebulr-group/bridge-nestjs @nebulr-group/bridge-auth-core @nestjs/core'), {
				...at,
				promptDir: 'api',
				shown: 'npm ls @nebulr-group/bridge-nestjs @nebulr-group/bridge-auth-core @nestjs/core'
			});
			expect(output).toContain(`@nebulr-group/bridge-nestjs@${NESTJS_PLUGIN_VERSION}`);
			expect(output).toContain('@nebulr-group/bridge-auth-core@');
		});
	} finally {
		execSync(`docker exec ${CONTAINER} rm -rf /w/api >/dev/null 2>&1 || true`);
		execSync(`docker rm -f ${CONTAINER} >/dev/null 2>&1 || true`);
		rmSync(dir, { recursive: true, force: true });
	}
});
