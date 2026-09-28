import { test, expect } from '../demo-kit';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * TBP-757 (milestone TBP-M35): flag rules on the backend see the same plan,
 * role and privileges as the browser.
 *
 * Two flags on a stage app: `analytics`, whose rule is "the workspace's plan
 * includes analytics" (Pro includes it, Free does not), and `manage-team`,
 * whose rule is the privilege "can change users" (`privileges contains
 * USER_WRITE`, which Owner has and Member does not). A fresh NestJS backend
 * from the published bridge-nestjs beta gates two endpoints with
 * `@RequireFlag`, and has no code that reads a plan, a role or a privilege.
 * A fresh SvelteKit page from the published bridge-svelte beta shows the same
 * two flags in the browser. For the Owner and for a Member of a Free
 * workspace, the backend (called with that person's own sign-in token)
 * answers exactly what the page shows. A context the client sends is
 * ignored. Then the workspace moves to Pro: the page follows live, and the
 * backend, asked from that page (bridgeFetch through the app's /api), follows
 * too, with no new sign-in.
 *
 * The plan change is made through the stage test endpoint, as a purchase
 * would make it. Setup is part of the file: the stage demo app is deleted and
 * recreated through the stage test endpoints (keyed by PLAYWRIGHT_TEST_API_KEY
 * from bridge-api/config/.env.stage, never printed); the Member is invited
 * with the published CLI and given a password by the test endpoint. Tokens
 * and passwords are masked. Both containers, the scratch projects and the
 * stage app are removed at the end.
 *
 * Re-run (memory preflight first — this starts three containers, installs one after the other):
 *   ~/Workflows/bin/run-demo.sh TBP-M35 bridge-plugins/bridge-nestjs/demos/one-flag-rule-same-answer-in-browser-and-backend.demo.ts \
 *     --base-url http://localhost:5297 --title "13 · TBP-757 · One flag rule, same answer in the browser and the backend"
 */

const STAGE = 'https://api-stage.thebridge.dev';
const API_DIR = process.env.DEMO_BRIDGE_API_DIR ?? '/Users/imanpouya/code/nebulr/thebridge-platform/bridge-api';
const SVELTE_VERSION = process.env.DEMO_SVELTE_VERSION ?? '0.9.0-beta.6';
const NESTJS_VERSION = process.env.DEMO_NESTJS_VERSION ?? '0.8.0-beta.1';
const AUTH_CORE_VERSION = process.env.DEMO_AUTH_CORE_VERSION ?? '0.8.0-beta.3';
const CLI_VERSION = process.env.DEMO_CLI_VERSION ?? '0.6.0-beta.7';
const DOMAIN = 'demo-flags-both-sides';
const OWNER = 'demo-flags-both-sides@example.com';
const MEMBER = 'demo-flags-both-sides-member@example.com';
const PORT = 5297;
const API_PORT = 5298;
const LOCAL = `http://localhost:${PORT}`;
const BACKEND = `http://localhost:${API_PORT}`;
const WEB = 'demo-flags-both-sides-web';
const API = 'demo-flags-both-sides-api';
const NETWORK = 'demo-flags-both-sides';

const rule = (attribute: string, operator: string, value: unknown) => ({
	branches: [{ conditions: [{ attribute, operator, values: [value] }], returnValue: true }],
	otherwiseValue: false,
	rolloutPct: 100
});
const FLAGS = [
	{ key: 'analytics', description: 'The analytics report: sold on Pro', rule: rule('bridge:billing.entitlement.analytics', 'eq', true) },
	{ key: 'manage-team', description: 'Team administration: people who can change users', rule: rule('privileges', 'contains', 'USER_WRITE') }
];

function stageKey(): string {
	const line = readFileSync(join(API_DIR, 'config/.env.stage'), 'utf8')
		.split('\n')
		.find((l) => l.startsWith('PLAYWRIGHT_TEST_API_KEY='));
	const key = line?.slice('PLAYWRIGHT_TEST_API_KEY='.length).trim().replace(/^"|"$/g, '');
	if (!key) throw new Error('PLAYWRIGHT_TEST_API_KEY missing from bridge-api/config/.env.stage');
	return key;
}

const headers = () => ({ 'Content-Type': 'application/json', 'x-playwright-api-key': stageKey() });

/** Stage Lambdas answer a cold first call with a 5xx now and then; retry once. */
async function json<T>(path: string, init: RequestInit): Promise<T> {
	let res = await fetch(`${STAGE}${path}`, init);
	if (!res.ok) {
		await new Promise((r) => setTimeout(r, 3000));
		res = await fetch(`${STAGE}${path}`, init);
	}
	if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${res.status}: ${await res.text()}`);
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}
const post = <T>(path: string, body: unknown) => json<T>(`/account/test/playwright/${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
const removeApp = () =>
	fetch(`${STAGE}/account/test/playwright/test-app`, { method: 'DELETE', headers: headers(), body: JSON.stringify({ domain: DOMAIN }) }).catch(() => {});

/** Why Bridge says `flag` is off for an anonymous visitor (null when on or not served yet). */
async function flagReason(appId: string, flag: string): Promise<string | null> {
	const res = await fetch(`${STAGE}/cloud-views/flags/bulkEvaluate/${appId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
	if (!res.ok) return null;
	const body = (await res.json()) as { flags: Array<{ flag: string; evaluation?: { reason?: string } }> };
	return body.flags.find((f) => f.flag === flag)?.evaluation?.reason ?? null;
}

function bridge(args: string): string {
	return (
		`docker run --rm -e BRIDGE_API_KEY -e BRIDGE_BASE_URL=${STAGE} -e BRIDGE_NO_BANNER=true ` +
		`-e NPM_CONFIG_UPDATE_NOTIFIER=false -e NPM_CONFIG_LOGLEVEL=error node:22 npx -y @nebulr-group/bridge-cli@${CLI_VERSION} ${args}`
	);
}

type Setup = { appId: string; tenantId: string; token: string; ownerPassword: string; memberPassword: string };

async function setup(): Promise<Setup> {
	const ownerPassword = `Demo-${Date.now()}-Aa1!`;
	const memberPassword = `Demo-${Date.now()}-Bb2!`;
	await removeApp();
	const app = await post<{ appId: string; tenantId: string }>('setup-test-app', { domain: DOMAIN, appName: 'Helpdesk', ownerEmail: OWNER, ownerPassword, appUrl: LOCAL });
	await post('configure-app', {
		appDomain: DOMAIN,
		allowedOrigins: [LOCAL],
		redirectUris: [`${LOCAL}/auth/oauth-callback`],
		defaultCallbackUri: `${LOCAL}/auth/oauth-callback`
	});
	for (const key of ['TEAM', 'premium', 'free']) await post('delete-plan', { appDomain: DOMAIN, key }).catch(() => undefined);
	await post('ensure-plan', { appDomain: DOMAIN, key: 'free', name: 'Free', trial: false, trialDays: 0, prices: [{ amount: 0, currency: 'USD', recurrenceInterval: 'month' }] });
	await post('ensure-plan', { appDomain: DOMAIN, key: 'pro', name: 'Pro', trial: false, trialDays: 0, prices: [{ amount: 29, currency: 'USD', recurrenceInterval: 'month' }] });
	await post('set-tenant-plan', { appDomain: DOMAIN, tenantId: app.tenantId, planKey: 'free', currency: 'USD', recurrenceInterval: 'month' });
	const { token } = await post<{ token: string }>('generate-jwt', {
		appDomain: DOMAIN,
		privileges: ['AUTHENTICATED', 'USER_READ', 'USER_WRITE', 'TENANT_READ', 'TENANT_WRITE']
	});
	const mgmt = { 'Content-Type': 'application/json', 'x-api-key': token };
	await json('/v1/account/payments/plan/pro', { method: 'PUT', headers: mgmt, body: JSON.stringify({ features: [{ key: 'analytics', name: 'Analytics' }] }) });
	for (const f of FLAGS) {
		await json('/v1/admin/flags/flag', {
			method: 'POST',
			headers: mgmt,
			body: JSON.stringify({ key: f.key, description: f.description, state: 'on-with-rule', valueType: 'boolean', onValue: true, offValue: false, rule: f.rule })
		});
	}
	// A teammate invited as Member, the role new apps give everyone after the first person (TBP-758).
	execSync(`${bridge(`user invite --email ${MEMBER} --role MEMBER --tenant-id ${app.tenantId}`)} > /dev/null`, { env: { ...process.env, BRIDGE_API_KEY: token } });
	// The invitation email would let them pick a password; the test endpoint sets one (for someone already in the workspace, only the password changes).
	const joined = await post<{ role: string }>('add-user-to-tenant', { workspaceId: app.appId, tenantId: app.tenantId, email: MEMBER, password: memberPassword, role: 'ADMIN' });
	expect(joined.role).toBe('MEMBER');
	// Bridge serves new rules once its flag cache has picked them up.
	await expect.poll(() => flagReason(app.appId, 'analytics'), { timeout: 120_000, intervals: [2000] }).toBe('plan');
	await expect.poll(() => flagReason(app.appId, 'manage-team'), { timeout: 120_000, intervals: [2000] }).toBe('permission');
	return { appId: app.appId, tenantId: app.tenantId, token, ownerPassword, memberPassword };
}

// ── the backend: a fresh NestJS app ─────────────────────────────────────────

const CONTROLLER = `import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeFlagGuard, RequireFlag } from '@nebulr-group/bridge-nestjs/flags';

@Controller()
@UseGuards(BridgeFlagGuard)
export class ReportsController {
  @Get('analytics')
  @RequireFlag('analytics')
  analytics() { return { report: 'Tickets closed this week: 42' }; }

  @Get('team-admin')
  @RequireFlag('manage-team')
  teamAdmin() { return { people: 2 }; }
}
`;

function writeBackend(dir: string, s: Setup) {
	const w = (path: string, text: string) => {
		mkdirSync(join(dir, path, '..'), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	w(
		'package.json',
		JSON.stringify(
			{
				name: 'helpdesk-api',
				private: true,
				scripts: { build: 'tsc', start: 'node dist/main.js' },
				dependencies: {
					'@nebulr-group/bridge-nestjs': NESTJS_VERSION,
					'@nebulr-group/bridge-auth-core': AUTH_CORE_VERSION,
					'@nestjs/common': '^11',
					'@nestjs/core': '^11',
					'@nestjs/platform-express': '^11',
					'reflect-metadata': '^0.2.2',
					rxjs: '^7.8.1'
				},
				devDependencies: { typescript: '^5.7.3', '@types/node': '^22', '@types/express': '^5' }
			},
			null,
			2
		)
	);
	w(
		'tsconfig.json',
		JSON.stringify(
			{
				compilerOptions: {
					module: 'commonjs',
					target: 'ES2021',
					outDir: './dist',
					rootDir: './src',
					experimentalDecorators: true,
					emitDecoratorMetadata: true,
					esModuleInterop: true,
					skipLibCheck: true,
					strictNullChecks: true
				},
				include: ['src/**/*']
			},
			null,
			2
		)
	);
	w('.env', `BRIDGE_APP_ID=${s.appId}\nBRIDGE_API_BASE_URL=${STAGE}\nBRIDGE_API_KEY=${s.token}\n`);
	w(
		'src/main.ts',
		`import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  await app.listen(3000);
  console.log('API listening on :3000');
}
bootstrap();
`
	);
	w(
		'src/app.module.ts',
		`import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';
import { BridgeFlagsModule } from '@nebulr-group/bridge-nestjs/flags';
import { ReportsController } from './reports.controller';

@Module({
  imports: [
    BridgeModule.forRoot({ guard: { global: true, defaultAccess: 'protected' } }),
    BridgeFlagsModule.forRoot({ apiBaseUrl: process.env.BRIDGE_API_BASE_URL!, apiKey: process.env.BRIDGE_API_KEY!, runtimeMode: 'pull' }),
  ],
  controllers: [ReportsController],
})
export class AppModule {}
`
	);
	w('src/reports.controller.ts', CONTROLLER);
}

// ── the frontend: a fresh SvelteKit app ─────────────────────────────────────

const PAGE = `<script lang="ts">
	import { bridgeFetch } from '@nebulr-group/bridge-svelte';
	import { FeatureFlag } from '@nebulr-group/bridge-svelte/flags';
	const why = (reason?: string) => (reason === 'plan' ? 'not on the plan' : reason === 'permission' ? 'not allowed for this person' : 'off');
	const endpoints: Record<string, string> = { analytics: '/api/analytics', 'manage-team': '/api/team-admin' };
	let backend = $state<Record<string, string>>({});

	// The app's own backend, called with the signed-in person's token (bridgeFetch).
	async function ask() {
		for (const [key, path] of Object.entries(endpoints)) {
			const res = await bridgeFetch(path);
			const body = await res.json().catch(() => ({}));
			backend[key] = res.ok ? \`\${res.status} open\` : \`\${res.status} \${body.code ?? ''}\`;
		}
	}
</script>

<h1>Helpdesk</h1>
<table>
	<thead><tr><th>Flag</th><th>In the browser</th><th>From the backend</th></tr></thead>
	<tbody>
		{#each Object.keys(endpoints) as key (key)}
			<tr>
				<td>{key}</td>
				<td>
					<FeatureFlag {key} defaultValue={false}>
						{#snippet children()}<b class="on" data-flag={key} data-state="on">on</b>{/snippet}
						{#snippet fallback(_v, { reason })}<b class="off" data-flag={key} data-state={reason ?? 'loading'}>off: {why(reason)}</b>{/snippet}
					</FeatureFlag>
				</td>
				<td data-backend={key}>{backend[key] ?? '—'}</td>
			</tr>
		{/each}
	</tbody>
</table>
<p><button onclick={ask}>Ask the backend</button></p>
`;

function writeFrontend(dir: string, appId: string) {
	const w = (path: string, text: string) => {
		mkdirSync(join(dir, path, '..'), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	w(
		'package.json',
		JSON.stringify(
			{
				name: 'helpdesk',
				private: true,
				type: 'module',
				scripts: { dev: `vite dev --host 0.0.0.0 --port ${PORT} --strictPort` },
				dependencies: { '@nebulr-group/bridge-svelte': SVELTE_VERSION, '@nebulr-group/bridge-auth-core': AUTH_CORE_VERSION },
				devDependencies: { '@sveltejs/kit': '^2', '@sveltejs/vite-plugin-svelte': '^5', svelte: '^5', vite: '^6' }
			},
			null,
			2
		)
	);
	// The app's own API answers on the app's own origin: Vite forwards /api to the backend container.
	w(
		'vite.config.js',
		`import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: { proxy: { '/api': { target: 'http://${API}:3000', rewrite: (p) => p.replace(/^\\/api/, '') } } }
});
`
	);
	w('svelte.config.js', 'export default { kit: {} };\n');
	w(
		'src/app.html',
		'<!doctype html>\n<html lang="en">\n\t<head>\n\t\t<meta charset="utf-8" />\n\t\t<meta name="viewport" content="width=device-width, initial-scale=1" />\n\t\t<style>table{border-collapse:collapse;font-size:1.25rem}th,td{padding:.6rem 1.5rem;border-bottom:1px solid #e5e7eb;text-align:left}.on{color:#065f46}.off{color:#991b1b}button{padding:.5rem 1rem;border:0;border-radius:.4rem;background:#4f46e5;color:#fff;font-size:1rem;cursor:pointer}</style>\n\t\t%sveltekit.head%\n\t</head>\n\t<body style="font-family: system-ui, sans-serif; margin: 72px 48px 48px">\n\t\t<div style="display: contents">%sveltekit.body%</div>\n\t</body>\n</html>\n'
	);
	w('.env', `VITE_BRIDGE_APP_ID=${appId}\nVITE_BRIDGE_API_BASE_URL=${STAGE}\n`);
	w(
		'src/routes/+layout.ts',
		`import { bridgeBootstrap } from '@nebulr-group/bridge-svelte';

export const ssr = false;
export const load = bridgeBootstrap({
	loginRoute: '/auth/login',
	rules: [{ match: new RegExp('^/auth($|/)'), public: true }],
	defaultAccess: 'protected'
});
`
	);
	w(
		'src/routes/+layout.svelte',
		`<script lang="ts">
	import { BridgeBootstrap } from '@nebulr-group/bridge-svelte';
	import '@nebulr-group/bridge-svelte/styles';
	let { children } = $props();
</script>

<BridgeBootstrap>{@render children()}</BridgeBootstrap>
`
	);
	w('src/routes/+page.svelte', PAGE);
	w('src/routes/auth/[...bridge]/+page.svelte', "<script lang=\"ts\">\n\timport { BridgeAuthRoutes } from '@nebulr-group/bridge-svelte';\n</script>\n\n<BridgeAuthRoutes />\n");
	w('src/routes/subscription/[...bridge]/+page.svelte', "<script lang=\"ts\">\n\timport { BridgeBillingRoutes } from '@nebulr-group/bridge-svelte';\n</script>\n\n<BridgeBillingRoutes />\n");
}

async function waitForUrl(url: string, timeoutMs: number) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		try {
			if ((await fetch(url)).ok) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`${url} did not come up within ${timeoutMs} ms`);
}

/** Headless Chromium has no address bar: pin the page's address to the top so the frame shows where the visitor is. */
async function showAddress(page: Page) {
	await page.evaluate(() => {
		document.getElementById('__demo_addr')?.remove();
		const bar = document.createElement('div');
		bar.id = '__demo_addr';
		bar.textContent = location.origin + location.pathname;
		bar.setAttribute(
			'style',
			'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483000;padding:6px 16px;border-radius:999px;' +
				'background:#f1f3f5;border:1px solid #d0d5db;color:#1d1f24;font:500 14px/1.3 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.08)'
		);
		document.documentElement.appendChild(bar);
	});
}

const npmInstall = (dir: string) =>
	`set -o pipefail; docker run --rm -v "${dir}":/w -w /w -e NPM_CONFIG_UPDATE_NOTIFIER=false -e NPM_CONFIG_LOGLEVEL=error -e NPM_CONFIG_FUND=false -e NPM_CONFIG_AUDIT=false node:22 npm install 2>&1 | tail -2`;

/** One line per endpoint: status, then the refusal's code and fix (or the body). $USER_TOKEN is the signed-in person's own token. */
const ASK_BACKEND =
	`for p in analytics team-admin; do printf '%-12s ' "/$p"; curl -s -w ' %{http_code}' -H "Authorization: Bearer $USER_TOKEN" ${BACKEND}/$p ` +
	`| sed -E 's/^(.*) ([0-9]{3})$/\\2 \\1/; s/"message":"[^"]*",?//; s/"statusCode":[0-9]+,?//; s/,}/}/'; echo; done`;

test('One flag rule gives the same answer in the browser and in the NestJS backend', async ({ demo }) => {
	test.setTimeout(14 * 60 * 1000);
	const { step, terminal, click, show, page } = demo;
	const s = await setup();
	const root = mkdtempSync(join(tmpdir(), 'helpdesk-'));
	const web = join(root, 'helpdesk');
	const api = join(root, 'helpdesk-api');
	writeFrontend(web, s.appId);
	writeBackend(api, s);
	const redact = [s.token, s.ownerPassword, s.memberPassword];
	const at = { cwd: web, promptDir: 'helpdesk', title: 'helpdesk — a fresh SvelteKit app', timeoutMs: 300_000, redact, env: { BRIDGE_API_KEY: s.token } };
	const atApi = { ...at, cwd: api, promptDir: 'helpdesk-api', title: 'helpdesk-api — a fresh NestJS app' };
	const cell = (key: string) => page.locator(`[data-flag="${key}"]`);

	const cleanup = () => {
		execSync(`docker rm -f ${WEB} ${API} >/dev/null 2>&1 || true`);
		execSync(`docker network rm ${NETWORK} >/dev/null 2>&1 || true`);
	};

	/** Sign in in the browser, and return the access token the app now holds for this person. */
	async function signIn(email: string, password: string): Promise<string> {
		await page.evaluate(() => localStorage.clear()).catch(() => undefined);
		await page.goto(`${LOCAL}/auth/login`);
		await expect(page.locator('#login-email')).toBeVisible({ timeout: 30_000 });
		await showAddress(page);
		await demo.type(page.locator('#login-email'), email);
		await page.locator('#login-password').fill(password);
		await click(page.getByRole('button', { name: 'Sign in', exact: true }));
		await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 30_000 });
		await expect(page.getByRole('heading', { name: 'Helpdesk' })).toBeVisible({ timeout: 30_000 });
		const raw = await page.evaluate((key) => localStorage.getItem(key), `bridge_tokens:${s.appId}`);
		const accessToken = raw ? (JSON.parse(raw) as { accessToken?: string }).accessToken : undefined;
		if (!accessToken) throw new Error('no access token in the browser after sign-in');
		return accessToken;
	}

	try {
		await step('Two flags: analytics is on when the plan includes analytics, and manage-team for people who can change users. Neither names a plan or a role', async () => {
			const { output } = await terminal(
				`for k in analytics manage-team; do ${bridge('flag get $k')} | jq -r '.data | "\\(.key)\\t\\(.rule.branches[0].conditions[0] | "\\(.attribute) \\(.operator) \\(.values[0])")"'; done | column -t -s $'\\t'`,
				{ ...at, clear: true, shown: 'bridge flag get analytics; bridge flag get manage-team' }
			);
			expect(output).toMatch(/analytics\s+bridge:billing\.entitlement\.analytics eq true/);
			expect(output).toMatch(/manage-team\s+privileges contains USER_WRITE/);
		});

		await step('The backend gates two endpoints with those flags, and has no code that reads a plan, a role or a privilege', async () => {
			const { output } = await terminal('cat src/reports.controller.ts', { ...atApi, clear: true });
			expect(output).toContain("@RequireFlag('analytics')");
			expect(output).toContain("@RequireFlag('manage-team')");
			expect(output).not.toMatch(/role|plan|privilege/i);
		});

		await step('Install both from the published packages and start them', async () => {
			cleanup();
			execSync(`docker network create ${NETWORK} >/dev/null`);
			await terminal(npmInstall(api), { ...atApi, clear: true, shown: `npm install @nebulr-group/bridge-nestjs@${NESTJS_VERSION}` });
			const started = await terminal(
				`docker run -d --rm --name ${API} --network ${NETWORK} -p ${API_PORT}:3000 --env-file .env -v "${api}":/w -w /w node:22 sh -c 'npm run build --silent && npm start --silent' > /dev/null ` +
					`&& for i in $(seq 1 120); do docker logs ${API} 2>&1 | grep -q 'listening' && break; sleep 1; done; docker logs ${API} 2>&1 | tail -2`,
				{ ...atApi, shown: 'npm run build && npm start' }
			);
			expect(started.output).toContain('API listening');
			await terminal(npmInstall(web), { ...at, shown: `npm install @nebulr-group/bridge-svelte@${SVELTE_VERSION} @nebulr-group/bridge-auth-core@${AUTH_CORE_VERSION}` });
			const { output } = await terminal(
				`docker run -d --rm --name ${WEB} --network ${NETWORK} -p ${PORT}:${PORT} -v "${web}":/w -w /w node:22 npm run dev > /dev/null ` +
					`&& for i in $(seq 1 90); do curl -sf ${LOCAL} > /dev/null && break; sleep 1; done ` +
					`&& docker logs ${WEB} 2>&1 | grep -E "Local:" | sed 's/\\x1b\\[[0-9;]*m//g'`,
				{ ...at, shown: 'npm run dev' }
			);
			expect(output).toContain(`localhost:${PORT}`);
			await waitForUrl(LOCAL, 30_000);
		});

		const ownerToken = await signIn(OWNER, s.ownerPassword);
		redact.push(ownerToken);

		await step('The Owner of a Free workspace, in the browser: analytics is not on the plan, team admin is on', async () => {
			await expect(cell('analytics')).toHaveAttribute('data-state', 'plan', { timeout: 30_000 });
			await expect(cell('manage-team')).toHaveAttribute('data-state', 'on', { timeout: 30_000 });
			await showAddress(page);
			await show(page.locator('table'));
		});

		await step('The backend, asked with the Owner’s own sign-in, gives the same answers: 402 upgrade for analytics, and team admin opens', async () => {
			const { output } = await terminal(ASK_BACKEND, { ...at, clear: true, env: { ...at.env, USER_TOKEN: ownerToken }, shown: 'curl -H "Authorization: Bearer $OWNER_TOKEN" localhost:5298/{analytics,team-admin}' });
			expect(output).toMatch(/\/analytics\s+402 .*"code":"FEATURE_NOT_IN_PLAN"/);
			expect(output).toMatch(/\/team-admin\s+200 .*"people":2/);
		});

		await step('A browser cannot talk its way in: a context claiming the plan includes analytics is ignored', async () => {
			const forged = Buffer.from(JSON.stringify({ v: 1, a: { 'bridge:billing.entitlement.analytics': true, 'bridge:billing.plan': 'pro' } })).toString('base64url');
			const { output } = await terminal(
				`curl -s -w ' %{http_code}\\n' -H "Authorization: Bearer $USER_TOKEN" -H "x-bridge-context: ${forged}" ${BACKEND}/analytics | sed -E 's/"message":"[^"]*",?//'`,
				{ ...at, env: { ...at.env, USER_TOKEN: ownerToken }, shown: `curl -H "x-bridge-context: {plan: pro, analytics: true}" localhost:5298/analytics` }
			);
			expect(output).toContain('FEATURE_NOT_IN_PLAN');
			expect(output).toMatch(/ 402\s*$/);
		});

		const memberToken = await signIn(MEMBER, s.memberPassword);
		redact.push(memberToken);

		await step('A Member of the same workspace: analytics is still not on the plan, and team admin is not allowed for them', async () => {
			await expect(cell('analytics')).toHaveAttribute('data-state', 'plan', { timeout: 30_000 });
			await expect(cell('manage-team')).toHaveAttribute('data-state', 'permission', { timeout: 30_000 });
			await showAddress(page);
			await show(page.locator('table'));
		});

		await step('The backend agrees with the Member’s browser: 402 upgrade for analytics, 403 not permitted for team admin', async () => {
			const { output } = await terminal(ASK_BACKEND, { ...at, clear: true, env: { ...at.env, USER_TOKEN: memberToken }, shown: 'curl -H "Authorization: Bearer $MEMBER_TOKEN" localhost:5298/{analytics,team-admin}' });
			expect(output).toMatch(/\/analytics\s+402 .*"code":"FEATURE_NOT_IN_PLAN"/);
			expect(output).toMatch(/\/team-admin\s+403 .*"code":"FEATURE_NOT_PERMITTED"/);
		});

		// The workspace buys Pro. On stage the test endpoint records the purchase.
		await post('set-tenant-plan', { appDomain: DOMAIN, tenantId: s.tenantId, planKey: 'pro', currency: 'USD', recurrenceInterval: 'month' });

		await step('The workspace moves to Pro. The Member’s page turns analytics on by itself, without signing in again', async () => {
			await expect(cell('analytics')).toHaveAttribute('data-state', 'on', { timeout: 90_000 });
			await expect(cell('manage-team')).toHaveAttribute('data-state', 'permission');
			await show(page.locator('table'));
		});

		await step('And the backend follows: asked from the Member’s page, analytics now opens and team admin stays closed. Still no new sign-in', async () => {
			// The backend reads the plan from Bridge, cached per workspace for up to 30 seconds; wait that out off
			// screen with the token the page holds now (a 402 on screen would open the upgrade dialog).
			await expect
				.poll(
					async () => {
						const raw = await page.evaluate((key) => localStorage.getItem(key), `bridge_tokens:${s.appId}`);
						const current = raw ? (JSON.parse(raw) as { accessToken?: string }).accessToken : '';
						return (await fetch(`${BACKEND}/analytics`, { headers: { Authorization: `Bearer ${current}` } })).status;
					},
					{ timeout: 90_000, intervals: [3_000] }
				)
				.toBe(200);
			await click(page.getByRole('button', { name: 'Ask the backend' }));
			await expect(page.locator('[data-backend="analytics"]')).toHaveText('200 open', { timeout: 15_000 });
			await expect(page.locator('[data-backend="manage-team"]')).toHaveText('403 FEATURE_NOT_PERMITTED');
			await show(page.locator('table'));
		});
	} finally {
		cleanup();
		execSync(`docker run --rm -v "${root}":/w node:22 rm -rf /w/helpdesk/node_modules /w/helpdesk/.svelte-kit /w/helpdesk-api/node_modules /w/helpdesk-api/dist >/dev/null 2>&1 || true`);
		rmSync(root, { recursive: true, force: true });
		await removeApp();
	}
});
