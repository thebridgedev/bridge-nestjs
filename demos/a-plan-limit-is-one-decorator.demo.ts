import { test, expect } from '../demo-kit';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * TBP-704 (milestone TBP-M35): a plan limit is one decorator on the API
 * handler that creates the thing.
 *
 * A fresh NestJS app using the published @nebulr-group/bridge-nestjs beta,
 * installed and run in a node:22 container. Its tickets controller carries
 * `@RequireQuota('tickets', { current })` (a gauge: the app counts its
 * tickets), `@SyncQuota` on delete, and `@RequireEntitlement` +
 * `@RequireQuota('exports')` (a counter: Bridge counts exports) on export.
 * A signed-in stage user then calls it with plain curl, the way any caller
 * bypassing a UI would: creates up to the plan's limit, is refused with 402
 * and a body naming the metric, the numbers and where to upgrade, deletes one
 * (Bridge's copy drops) and creates again, and exports twice with one
 * Idempotency-Key, which Bridge counts once. What the plugin wrote is read
 * back from Bridge's own usage API, not from the app.
 *
 * Setup is part of the file and starts from a clean app every run: the stage
 * demo app is deleted and recreated through the stage test endpoints (keyed
 * by PLAYWRIGHT_TEST_API_KEY from bridge-api/config/.env.stage, never
 * printed), a "Team" plan gets its quotas (tickets: gauge, hard 3; exports:
 * counter, hard 50) and the workspace is put on it. The owner is signed in
 * server-side, the way an SDK does, for a workspace user's token; tokens only
 * live in env and are masked. The container, the scratch project and the
 * stage app are removed at the end.
 *
 * Re-run (memory preflight first — this starts two containers, one after the other):
 *   ~/Workflows/bin/run-demo.sh TBP-704 bridge-plugins/bridge-nestjs/demos/a-plan-limit-is-one-decorator.demo.ts
 */

const STAGE = 'https://api-stage.thebridge.dev';
const API_DIR = process.env.DEMO_BRIDGE_API_DIR ?? '/Users/imanpouya/code/nebulr/thebridge-platform/bridge-api';
const NESTJS_VERSION = process.env.DEMO_NESTJS_VERSION ?? '0.8.0-beta.1';
const AUTH_CORE_VERSION = process.env.DEMO_AUTH_CORE_VERSION ?? '0.8.0-beta.3';
const DOMAIN = 'demo-quota-decorators';
const OWNER = 'demo-quota-decorators@example.com';
const ORIGIN = 'http://localhost:5173';
const PORT = 3293;
const LOCAL = `http://localhost:${PORT}`;
const CONTAINER = 'demo-bridge-quota-decorators';
const TICKET_LIMIT = 3;

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

type Setup = { appId: string; tenantId: string; password: string; signIn: () => Promise<string> };

async function setup(): Promise<Setup> {
	const password = `Demo-${Date.now()}-Aa1!`;
	await removeApp();
	const app = await post<{ appId: string; tenantId: string }>('setup-test-app', {
		domain: DOMAIN,
		appName: 'Quota decorators demo',
		ownerEmail: OWNER,
		ownerPassword: password,
		appUrl: ORIGIN
	});
	await post('configure-app', { appDomain: DOMAIN, allowedOrigins: [ORIGIN] });
	await post('ensure-plan', { appDomain: DOMAIN, key: 'team', name: 'Team', prices: [{ amount: 10, currency: 'USD', recurrenceInterval: 'month' }] });
	const { token: apiToken } = await post<{ token: string }>('generate-jwt', {
		appDomain: DOMAIN,
		privileges: ['AUTHENTICATED', 'USER_READ', 'USER_WRITE', 'TENANT_READ', 'TENANT_WRITE']
	});
	await json('/v1/account/payments/plan/team', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'x-api-key': apiToken },
		body: JSON.stringify({
			quotas: [
				{ metric: 'tickets', limit: TICKET_LIMIT, policy: 'hard', kind: 'gauge' },
				{ metric: 'exports', limit: 50, policy: 'hard', kind: 'counter' }
			]
		})
	});
	await post('set-tenant-plan', { appDomain: DOMAIN, tenantId: app.tenantId, planKey: 'team', currency: 'USD', recurrenceInterval: 'month' });

	// Sign the workspace owner in the way an SDK does, for a workspace user's token.
	// A usage change asks every signed-in member to refresh their token (an SDK
	// does it on its own); the demo stands in for that by signing in afresh per call.
	const signIn = async (): Promise<string> => {
		const h = { 'content-type': 'application/json', origin: ORIGIN };
		const auth = await json<{ session: string; tenantUsers: Array<{ id: string }> }>('/auth/authenticate', {
			method: 'POST',
			headers: h,
			body: JSON.stringify({ mode: 'sdk', appId: app.appId, username: OWNER, password })
		});
		const tokens = await json<{ access_token: string }>('/auth/token/direct', {
			method: 'POST',
			headers: h,
			body: JSON.stringify({ mode: 'sdk', appId: app.appId, session: auth.session, tenantUserId: auth.tenantUsers[0].id })
		});
		return tokens.access_token;
	};
	return { appId: app.appId, tenantId: app.tenantId, password, signIn };
}

const CONTROLLER = `import { Controller, Delete, Param, Post } from '@nestjs/common';
import { BridgeTenant, CurrentTenant } from '@nebulr-group/bridge-nestjs';
import { RequireEntitlement, RequireQuota, SyncQuota } from '@nebulr-group/bridge-nestjs';
import { TicketsService } from './tickets.service';

@Controller('tickets')
export class TicketsController {
  constructor(readonly tickets: TicketsService) {}

  @Post()   // tickets exist, so the app counts them; Bridge refuses at the plan limit
  @RequireQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  create(@CurrentTenant() t: BridgeTenant) { return this.tickets.create(t.id); }

  @Delete(':id')   // deleting one frees room
  @SyncQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  remove(@CurrentTenant() t: BridgeTenant, @Param('id') id: string) { return this.tickets.remove(t.id, id); }

  @Post(':id/export')   // exports happen, so Bridge counts them
  @RequireEntitlement('app_active')
  @RequireQuota('exports')
  export(@Param('id') id: string) { return { exported: id, format: 'csv' }; }
}
`;

const SERVICE = `import { Injectable, NotFoundException } from '@nestjs/common';

/** The app's own tickets. In a real app, the database. */
@Injectable()
export class TicketsService {
  private readonly byTenant = new Map<string, string[]>();
  private seq = 0;

  countFor(tenantId: string) { return this.byTenant.get(tenantId)?.length ?? 0; }

  create(tenantId: string) {
    const id = \`t\${++this.seq}\`;
    this.byTenant.set(tenantId, [...(this.byTenant.get(tenantId) ?? []), id]);
    return { id };
  }

  remove(tenantId: string, id: string) {
    const ids = this.byTenant.get(tenantId) ?? [];
    if (!ids.includes(id)) throw new NotFoundException();
    this.byTenant.set(tenantId, ids.filter((x) => x !== id));
    return { deleted: id };
  }
}
`;

const MODULE = `import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [BridgeModule.forRoot({ guard: { global: true, defaultAccess: 'protected' } })],
  controllers: [TicketsController],
  providers: [TicketsService],
})
export class AppModule {}
`;

/** A fresh NestJS app: what \`nest new\` gives, trimmed, plus the tickets feature. */
function writeProject(dir: string, appId: string) {
	const w = (path: string, text: string) => {
		mkdirSync(join(dir, path, '..'), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	w(
		'package.json',
		JSON.stringify(
			{
				name: 'my-api',
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
	w('.env', `BRIDGE_APP_ID=${appId}\nBRIDGE_API_BASE_URL=${STAGE}\n`);
	w(
		'src/main.ts',
		`import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  await app.listen(process.env.PORT ?? 3000);
  console.log(\`API listening on http://localhost:\${process.env.PORT ?? 3000}\`);
}
bootstrap();
`
	);
	w('src/app.module.ts', MODULE);
	w('src/tickets.controller.ts', CONTROLLER);
	w('src/tickets.service.ts', SERVICE);
}

async function waitForUp(url: string, timeoutMs: number) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		try {
			await fetch(url);
			return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`${url} did not come up within ${timeoutMs} ms`);
}

test('A plan limit is one decorator on the API handler', async ({ demo }) => {
	const { step, terminal } = demo;
	const s = await setup();
	const dir = mkdtempSync(join(tmpdir(), 'my-api-'));
	writeProject(dir, s.appId);
	const at = { cwd: dir, promptDir: 'my-api', title: 'my-api — a fresh NestJS app', timeoutMs: 300_000, redact: [s.password] };

	/** A call as the signed-in workspace user; the token only lives in env. */
	const asUser = async (command: string, shown: string, clear = false, expectExit: number | 'any' = 0) =>
		terminal(command, { ...at, clear, shown, expectExit, env: { TOKEN: await s.signIn() } });
	const H = `-H "Authorization: Bearer $TOKEN"`;
	/** Our API: prints the body, then the status. */
	const api = (method: string, path: string, extra = '') =>
		`curl -sS -X ${method} ${H} ${extra} ${LOCAL}${path} -w '  → HTTP %{http_code}\\n'`;
	/** Bridge's own view of a quota — what the plugin actually wrote. */
	const bridgeQuota = (metric: string) =>
		`curl -sS ${H} ${STAGE}/v1/usage/quota/${metric} | jq -c '{metric, kind, used, limit}'`;
	/** Rollups are near-instant, but give Bridge a moment before reading back. */
	const settle = () => new Promise((r) => setTimeout(r, 1500));

	try {
		await step('The tickets API: one decorator on create enforces the plan limit, one on delete keeps Bridge in step', async () => {
			const { output } = await terminal('cat src/tickets.controller.ts', { ...at, clear: true });
			expect(output).toContain("@RequireQuota('tickets', { current:");
			expect(output).toContain("@SyncQuota('tickets', { current:");
			expect(output).toContain("@RequireEntitlement('app_active')");
		});

		await step('The module needs no Bridge settings in code: it reads the app id and the Bridge address from the environment', async () => {
			const { output } = await terminal(`grep -n 'forRoot' src/app.module.ts && cat .env`, { ...at, clear: true });
			expect(output).toContain("BridgeModule.forRoot({ guard: { global: true, defaultAccess: 'protected' } })");
			expect(output).toContain(`BRIDGE_API_BASE_URL=${STAGE}`);
		});

		await step('Install the published package and start the API', async () => {
			await terminal(
				`set -o pipefail; docker run --rm -v "${dir}":/w -w /w -e NPM_CONFIG_UPDATE_NOTIFIER=false -e NPM_CONFIG_LOGLEVEL=error -e NPM_CONFIG_FUND=false -e NPM_CONFIG_AUDIT=false node:22 npm install 2>&1 | tail -2`,
				{ ...at, clear: true, shown: `npm install @nebulr-group/bridge-nestjs@${NESTJS_VERSION}` }
			);
			execSync(`docker rm -f ${CONTAINER} >/dev/null 2>&1 || true`);
			const { output } = await terminal(
				`docker run -d --rm --name ${CONTAINER} -p ${PORT}:${PORT} -e PORT=${PORT} --env-file .env -v "${dir}":/w -w /w node:22 sh -c 'npm run build --silent && npm start --silent' > /dev/null ` +
					`&& for i in $(seq 1 120); do docker logs ${CONTAINER} 2>&1 | grep -q 'listening' && break; sleep 1; done; docker logs ${CONTAINER} 2>&1 | tail -3`,
				{ ...at, shown: 'npm run build && npm start' }
			);
			expect(output).toContain('API listening');
			await waitForUp(LOCAL, 30_000);
		});

		await step(`This workspace's plan allows ${TICKET_LIMIT} tickets, and Bridge knows of none yet`, async () => {
			const { output } = await asUser(bridgeQuota('tickets'), `curl ${H} ${STAGE}/v1/usage/quota/tickets`, true);
			expect(output).toContain(`"used":0`);
			expect(output).toContain(`"limit":${TICKET_LIMIT}`);
		});

		await step(`A signed-in user creates ${TICKET_LIMIT} tickets straight against the API, no UI involved`, async () => {
			const { output } = await asUser(
				`for i in $(seq 1 ${TICKET_LIMIT}); do ${api('POST', '/tickets')}; done`,
				`for i in 1 2 3; do curl -X POST ${H} ${LOCAL}/tickets; done`
			);
			expect(output.match(/HTTP 201/g)?.length).toBe(TICKET_LIMIT);
		});

		await step('The next create is refused with 402, naming the metric, the numbers and where to upgrade; nothing is created', async () => {
			const { output } = await asUser(`${api('POST', '/tickets')} | sed 's/,"/, "/g'`, `curl -X POST ${H} ${LOCAL}/tickets`, true);
			expect(output).toContain('HTTP 402');
			expect(output).toMatch(/"code":\s?"QUOTA_EXCEEDED"/);
			expect(output).toMatch(/"metric":\s?"tickets"/);
			expect(output).toMatch(/"used":\s?3/);
			expect(output).toMatch(/"limit":\s?3/);
			expect(output).toMatch(/"fix":\s?"\/subscription"/);
		});

		await step(`Bridge's own copy of the count says ${TICKET_LIMIT} of ${TICKET_LIMIT}, kept current by the decorator`, async () => {
			await settle();
			const { output } = await asUser(bridgeQuota('tickets'), `curl ${H} ${STAGE}/v1/usage/quota/tickets`);
			expect(output).toContain(`"used":${TICKET_LIMIT}`);
			expect(output).toContain('"kind":"gauge"');
		});

		await step("Deleting a ticket lowers Bridge's count to 2, with no reset and no extra code", async () => {
			await asUser(api('DELETE', '/tickets/t1'), `curl -X DELETE ${H} ${LOCAL}/tickets/t1`, true);
			await settle();
			const { output } = await asUser(bridgeQuota('tickets'), `curl ${H} ${STAGE}/v1/usage/quota/tickets`);
			expect(output).toContain(`"used":${TICKET_LIMIT - 1}`);
		});

		await step('…so creating a ticket works again', async () => {
			const { output } = await asUser(api('POST', '/tickets'), `curl -X POST ${H} ${LOCAL}/tickets`);
			expect(output).toContain('HTTP 201');
		});

		await step('Exports are a counter Bridge keeps. The same export sent twice with one Idempotency-Key…', async () => {
			const before = await asUser(bridgeQuota('exports'), `curl ${H} ${STAGE}/v1/usage/quota/exports`, true);
			expect(before.output).toContain('"used":0');
			const key = 'export-t2-once';
			const { output } = await asUser(
				`for i in 1 2; do ${api('POST', '/tickets/t2/export', `-H 'Idempotency-Key: ${key}'`)}; done`,
				`for i in 1 2; do curl -X POST ${H} ${LOCAL}/tickets/t2/export -H 'Idempotency-Key: ${key}'; done`
			);
			expect(output.match(/HTTP 201/g)?.length).toBe(2);
		});

		await step('…counts once in Bridge', async () => {
			await settle();
			const { output } = await asUser(bridgeQuota('exports'), `curl ${H} ${STAGE}/v1/usage/quota/exports`);
			expect(output).toContain('"used":1');
			expect(output).toContain('"kind":"counter"');
		});
	} finally {
		execSync(`docker rm -f ${CONTAINER} >/dev/null 2>&1 || true`);
		execSync(`docker run --rm -v "${dir}":/w node:22 rm -rf /w/node_modules /w/dist >/dev/null 2>&1 || true`);
		rmSync(dir, { recursive: true, force: true });
		await removeApp();
	}
});
