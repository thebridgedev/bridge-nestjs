// The 1.0 guides on this line (mcp/, learning/, both READMEs) teach only what
// bridge-nestjs 1.0, the new Bridge and CLI 1.0 have.
//
// 1. TBP-705: no guide teaches a direct role, privilege, plan or plan-feature
//    check outside its Exceptions section (owner rule 2026-09-29: every gate
//    in app code is a flag; its rule says why). The pattern list and scanner
//    MIRROR bridge-cli `src/gate-rules.ts` (DOC_FORBIDDEN / docGateViolations).
// 2. TBP-292 / TBP-355: no 0.x setting, API or old-server name, and no
//    `bridge <command>` (or option) that CLI 1.0 does not have. The command
//    tree is scripts/cli-1.0-commands.txt, generated from bridge-cli v1.
// 3. E5: a browser check is never called "display, not enforcement",
//    "display only" or decoration.
// 4. TBP-812: the billing and flag guides split their verify step into
//    terminal and browser checks, with the Heads up rule.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// ── Mirror of bridge-cli src/gate-rules.ts ─────────────────────────────────

const DOC_FORBIDDEN: Array<[string, RegExp]> = [
  ['a role compared in code', /\b(?:user|session|claims|token|me|currentUser|profile|locals\.user|req\.user|\$user|\$profile)\??\.role\s*(?:===|!==|==|!=)/],
  ['a role compared in code', /\brole\s*(?:===|!==|==|!=)\s*['"`]/i],
  ['a role list checked in code', /\[\s*['"][A-Z_]+['"](?:\s*,\s*['"][A-Z_]+['"])*\s*\]\s*\.includes\(/],
  ['a role checked in code', /\bhasRole\s*\(/],
  ['a role decorator on a handler', /@RequireRole\s*\(/],
  ['a role check on the page', /\brole check\b[^.\n]{0,30}\b(?:in|on) (?:the |your )?(?:page|component|code|handler|layout|controller)/i],
  ['a role check on the page', /\bcheck\w*\b[^.\n]{0,30}\brole\b[^.\n]{0,30}\b(?:in|on) (?:the |your )?(?:page|component|code|layout)\b/i],
  ['"target a role instead"', /target a role instead/i],
  ['privileges read in code', /\bprivileges\s*\??\.\s*(?:includes|some|indexOf|has)\s*\(/],
  ['a direct plan-feature check', /<Entitled\b/],
  ['a direct plan-feature check', /\bentitlements\s*\??\.\s*can\s*\(/],
  ['a direct plan-feature check', /@RequireEntitlement\s*\(/],
  ['a plan name compared in code', /\.plan(?:Key|Name|Slug)?\s*(?:===|!==|==|!=)\s*['"`]/],
  ['a plan name compared in code', /\bplan(?:Key|Name|Slug)?\s*(?:===|!==|==|!=)\s*['"`]/i],
  ['a plan-name helper', /\bis(?:Pro|Free|Enterprise|Team|Business)(?:Plan|User)?\b\s*[(=]/],
  ['a route rule on plans', /\bplans\s*:\s*\[/],
  ['a route rule on a role', /\{[^}\n]*\b(?:match|path)\s*:[^}\n]*\brole\s*:\s*['"`]/],
  ['a route rule on a privilege', /\bprivilege\s*:\s*['"`](?!ANONYMOUS|AUTHENTICATED)[A-Z_]+['"`]/],
  ['a flag rule that names plans', /"attribute"\s*:\s*"(?:tenant\.plan|bridge:billing\.plan)"/],
  ['browser counting called demo-grade', /demo[- ]grade/i],
  ['browser counting called display only', /display,? not enforcement/i],
  ['browser counting said unable to refuse', /only (?:a|the|your) backend can (?:refuse|enforce|stop)/i],
  [
    'browser counting said not to work',
    /\b(?:browser|frontend|client)(?:[- ](?:only|side))?\b[^.\n]{0,40}\b(?:won't|will not|does not|doesn't|cannot|can't|can not) (?:work|enforce|be trusted)/i,
  ],
  ['browser counting said not production-ready', /\b(?:browser|frontend|client)\b[^.\n]{0,60}\bnot (?:production|prod)[- ](?:ready|grade)/i],
  // TBP-757: `contains` on privileges is exact membership; advice written around the old substring match is stale.
  ['privileges said to match as text', /\b(?:matched|matches|match) (?:privilege keys )?as text\b|\bno other (?:privilege )?key contains\b/i],
];

/** A sentence that tells the reader NOT to do the forbidden thing. */
const NEGATED = /\b(?:never|instead of|rather than|do not|don't|not a|is gone|no longer)\b/i;

const HEADING = /^(#{1,6})\s+(.*)$/;

type DocViolation = { line: number; rule: string; text: string };

function docGateViolations(markdown: string): DocViolation[] {
  const out: DocViolation[] = [];
  let exceptionLevel = 0; // heading depth of the Exceptions section we are in, 0 = none
  let inFence = false;
  markdown.split('\n').forEach((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (exceptionLevel && level <= exceptionLevel) exceptionLevel = 0;
      if (/exception/i.test(heading[2])) exceptionLevel = level;
      return;
    }
    if (exceptionLevel) return;
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (NEGATED.test(sentence)) continue;
      for (const [rule, pattern] of DOC_FORBIDDEN) {
        if (pattern.test(sentence)) out.push({ line: i + 1, rule, text: sentence.trim() });
      }
    }
  });
  return out;
}


// ── The repo's agent-facing guides ─────────────────────────────────────────

const REPO = join(__dirname, '..', '..');

function markdownUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...markdownUnder(full));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

const GUIDES = [
  ...markdownUnder(join(REPO, 'mcp')),
  ...markdownUnder(join(REPO, 'learning')),
  join(REPO, 'README.md'),
  join(REPO, 'bridge-nestjs', 'README.md'),
];

const RULE_HEADING = '## The one rule for app code';
/** The NestJS line of the rule block, with the 1.0 name or its 0.x alias. */
const NESTJS_LINE = /an endpoint is `@Require(?:Feature)?Flag\('…'\)` on the handler/;
const CHECK_GATES = /npx @nebulr-group\/bridge-cli(?:@alpha)? check gates/;

describe('agent-facing guides follow "every gate is a flag" (TBP-705)', () => {
  it('scans the guides it is meant to (not nothing)', () => {
    expect(GUIDES.length).toBeGreaterThan(3);
    for (const file of GUIDES) expect(statSync(file).size).toBeGreaterThan(0);
  });

  it('no guide teaches a direct role, privilege, plan or plan-feature check outside its Exceptions section', () => {
    const found = GUIDES.flatMap((file) =>
      docGateViolations(readFileSync(file, 'utf8')).map(
        (v) => `${relative(REPO, file)}:${v.line} — ${v.rule}: ${v.text}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('every mcp guide and README opens with the rule block and the NestJS line', () => {
    const entryGuides = [...markdownUnder(join(REPO, 'mcp')), join(REPO, 'README.md')];
    expect(entryGuides.length).toBeGreaterThan(3);
    const missing = entryGuides.filter((file) => {
      const md = readFileSync(file, 'utf8');
      const h2 = md.split('\n').find((l) => /^## /.test(l));
      return h2 !== RULE_HEADING || !NESTJS_LINE.test(md) || !CHECK_GATES.test(md);
    });
    expect(missing.map((f) => relative(REPO, f))).toEqual([]);
  });

  it('no guide mentions an API the plugin no longer has, even in an Exceptions section', () => {
    const removed = /@RequireRole\b|\bplans\s*:\s*\[|\bentitlement\s*:\s*['"[]/;
    const found = GUIDES.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => removed.test(line) && !/\b(?:is gone|was removed|no longer|removed)\b/i.test(line))
        .map(({ line, i }) => `${relative(REPO, file)}:${i + 1}: ${line.trim()}`),
    );
    expect(found).toEqual([]);
  });
});

describe('the doc check itself', () => {
  it('goes red on planted bad lines', () => {
    const planted = [
      "if (req.user.role === 'ADMIN') return;",
      "if (role === 'OWNER') { … }",
      "if (['OWNER', 'ADMIN'].includes(user.role)) { … }",
      'Put `@RequireRole(\'ADMIN\')` on the handler.',
      "if (user.privileges.includes('USER_WRITE')) { … }",
      "@RequireEntitlement('analytics')",
      "if (await tenant.entitlements.can('analytics')) { … }",
      '<Entitled to="analytics">…</Entitled>',
      "if (planKey === 'pro') { … }",
      "{ path: '/reports/*', privilege: 'AUTHENTICATED', plans: ['pro'] }",
      "{ path: '/admin/*', privilege: 'TENANT_WRITE' }",
      "{ path: '/admin/*', role: 'ADMIN' }",
      "{ match: '/admin/*', role: 'ADMIN', redirectTo: '/' }",
      '{ "attribute": "tenant.plan", "operator": "eq", "value": "pro" }',
      'Browser-only counting is display, not enforcement.',
      'Counting in the browser is demo-grade.',
      'Only a backend can refuse the request.',
      "A browser-only counter can't enforce the limit.",
    ];
    for (const line of planted) {
      expect({ line, flagged: docGateViolations(`# Guide\n\n${line}\n`).length > 0 }).toEqual({ line, flagged: true });
    }
  });

  it('stays green on the rule\'s own sentences', () => {
    const ruleBlock = [
      RULE_HEADING,
      '',
      "**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains \"USER_WRITE\"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.",
      '',
      'Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").',
      '',
      'Before calling the work done, run `npx @nebulr-group/bridge-cli check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.',
      '',
      "In NestJS, an endpoint is `@RequireFeatureFlag('…')` on the handler (or a route rule with `featureFlag`).",
      "{ path: '/health', privilege: 'ANONYMOUS' }",
      "{ path: '/admin/*', privilege: 'AUTHENTICATED', featureFlag: 'admin-area' }",
      "`@RequirePrivilege('USER_READ')` is an API-token scope — API tokens only.",
      "await team.updateUser({ email, role: 'MEMBER' });",
      'Never compare `user.role === \'ADMIN\'` in a handler.',
      '',
      '## Exceptions',
      '',
      "`@RequireEntitlement('analytics')` checks the plan directly, for when the developer explicitly asks for no flag.",
      '',
      '## Next section',
      '',
      'Browser-only counting is complete: it trusts the browser.',
    ].join('\n');
    expect(docGateViolations(ruleBlock)).toEqual([]);
  });

  it('an Exceptions section ends at the next heading of the same level', () => {
    const md = ['## Exceptions', "@RequireEntitlement('a')", '### Detail', "@RequireEntitlement('b')", '## After', "@RequireEntitlement('c')"].join('\n');
    expect(docGateViolations(md).map((v) => v.line)).toEqual([6]);
  });
});

// ── The 1.0 checks ─────────────────────────────────────────────────────────

/** Names from 0.x, from the old Bridge API, or wordings the owner retired (E5, TBP-812). */
const BANNED: Array<[string, RegExp]> = [
  ['a 0.x setting', /\bVITE_BRIDGE_APP_ID\b|\bVITE_BRIDGE_API_BASE_URL\b|\bVITE_BRIDGE_CALLBACK_URL\b|\bPUBLIC_BRIDGE_APP_ID\b/],
  ['a 0.x setting', /\bBRIDGE_API_BASE_URL\b|\bBRIDGE_APP_ID\b/],
  ['the old Bridge API', /\bbridge-api\b|api(?:-stage)?\.thebridge\.dev/],
  ['a 0.x CLI command', /--ui-url\b|\bbridge app redirect-uris\b/],
  ['the 0.x browser plan gate', /<Entitled\b/],
  ['the unified surface that never shipped', /\binitBridge\b|\buseBridge\b/],
  ['a 0.x NestJS API', /@CurrentUser\b|@CurrentTenant\b|\bBridgeFlagsModule\b|\bBridgeFlagGuard\b|\bBridgeFlagsService\b|\bruntimeMode\b|\bBridgePullCache\b|@RequirePrivilege\b|\bJwksService\b|\bBridgeHttpService\b|\bfromJwt\b|\bTenantScope\b|\bgraphqlOperation\b/],
  ['E5: a browser check called display only', /display,? not enforcement|display[- ]only|\bdecorat(?:ion|ive)\b|client decorates/i],
  ['TBP-812: the agent claims browser checks', /the agent verifies/i],
];

/** A section that names old names on purpose: the upgrade notes. */
const UPGRADE_HEADING = /upgrad|migrat|from 0\.x/i;

function bannedNames(markdown: string): DocViolation[] {
  const out: DocViolation[] = [];
  let upgradeLevel = 0;
  let inFence = false;
  markdown.split('\n').forEach((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (upgradeLevel && level <= upgradeLevel) upgradeLevel = 0;
      if (UPGRADE_HEADING.test(heading[2])) upgradeLevel = level;
    }
    if (upgradeLevel) return;
    for (const [rule, pattern] of BANNED) if (pattern.test(line)) out.push({ line: i + 1, rule, text: line.trim() });
  });
  return out;
}

interface CliCommand {
  readonly options: ReadonlySet<string>;
  readonly hasChildren: boolean;
}

/** scripts/cli-1.0-commands.txt: "bridge <path…> <args…>  --option …" per line. */
function readCommandTree(text: string): Map<string, CliCommand> {
  const rows = text
    .split('\n')
    .filter((line) => line.startsWith('bridge '))
    .map((line) => {
      const tokens = line.trim().split(/\s+/);
      const path: string[] = [];
      for (const token of tokens) {
        if (/^[<[]|^--/.test(token)) break;
        path.push(token);
      }
      return { path: path.join(' '), options: new Set(tokens.filter((token) => token.startsWith('--'))) };
    });
  const tree = new Map<string, CliCommand>();
  for (const row of rows) tree.set(row.path, { options: row.options, hasChildren: rows.some((other) => other.path.startsWith(`${row.path} `)) });
  tree.set('bridge', { options: new Set(), hasChildren: true });
  return tree;
}

const ROOT_OPTIONS = new Set(['--server', '--issuer', '--app', '--help', '--version']);

/** The code in a guide: fenced blocks and `inline spans`, with their line numbers. */
function codeOf(markdown: string): Array<{ line: number; code: string }> {
  const out: Array<{ line: number; code: string }> = [];
  let inFence = false;
  markdown.split('\n').forEach((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) out.push({ line: i + 1, code: line });
    else for (const span of line.match(/`[^`]+`/g) ?? []) out.push({ line: i + 1, code: span.slice(1, -1) });
  });
  return out;
}

/** Every `bridge …` (or `npx @nebulr-group/bridge-cli… …`) a guide shows that CLI 1.0 does not have. */
function unknownCommands(markdown: string, tree: Map<string, CliCommand>): DocViolation[] {
  const out: DocViolation[] = [];
  const invocation = /(?:^|[\s(])(?:npx\s+@nebulr-group\/bridge-cli(?:@[\w.-]+)?|bridge)\s+([^|;&#\n]*)/g;
  for (const { line, code } of codeOf(markdown)) {
    for (const match of code.matchAll(invocation)) {
      const tokens = match[1].trim().split(/\s+/).filter(Boolean);
      let path = 'bridge';
      let used = 0;
      while (used < tokens.length && tree.has(`${path} ${tokens[used]}`)) path = `${path} ${tokens[used++]}`;
      const command = tree.get(path) as CliCommand;
      const next = tokens[used];
      if (next !== undefined && command.hasChildren && /^[a-z][a-z-]*$/.test(next)) {
        out.push({ line, rule: `no CLI 1.0 command "${path} ${next}"`, text: code.trim() });
        continue;
      }
      if (path === 'bridge') continue; // prose such as "the bridge is …" inside code never names a command
      for (const token of tokens.slice(used)) {
        const option = token.replace(/=.*$/, '');
        if (/^--[a-z]/.test(option) && !command.options.has(option) && !ROOT_OPTIONS.has(option)) {
          out.push({ line, rule: `"${path}" has no option ${option} in CLI 1.0`, text: code.trim() });
        }
      }
    }
  }
  return out;
}

/**
 * learning/ on this line still describes 0.x (its README says so; the package README is the 1.0 guide). These pages
 * are ported with the 1.0 docs and are exempt from the 1.0 checks until then. The list may only shrink: a page not on
 * it is checked, and a listed page that passes must come off it.
 */
const LEARNING_STILL_0X = [
  'learning/README.md',
  'learning/auth/api-tokens/api-tokens.md',
  'learning/auth/auth.md',
  'learning/auth/config/config.md',
  'learning/auth/multi-tenancy/multi-tenancy.md',
  'learning/auth/roles/assign-roles.md',
  'learning/auth/roles/common-setups.md',
  'learning/auth/roles/define-roles.md',
  'learning/auth/roles/gate-with-flags.md',
  'learning/auth/roles/how-it-works.md',
  'learning/auth/roles/owner-role.md',
  'learning/auth/securing/route-guards.md',
  'learning/auth/user-token/getting-the-token.md',
  'learning/auth/user-token/logging-in-and-out.md',
  'learning/auth/user-token/object-updates.md',
  'learning/bridge-service/bridge-service.md',
  'learning/configuration/configuration.md',
  'learning/error-handling/error-handling.md',
  'learning/examples/examples.md',
  'learning/feature-flags/feature-flags.md',
  'learning/feature-flags/get-started/get-started.md',
  'learning/feature-flags/how-it-works/how-it-works.md',
  'learning/feature-flags/targeting/by-plan-or-role.md',
  'learning/feature-flags/targeting/send-context.md',
  'learning/feature-flags/using/backend.md',
  'learning/feature-flags/using/guard-routes.md',
  'learning/feature-flags/using/in-logic.md',
  'learning/frontend-integration/frontend-integration.md',
  'learning/multi-tenancy/multi-tenancy.md',
  'learning/quickstart/quickstart.md',
];
const CURRENT_GUIDES = GUIDES.filter((file) => !LEARNING_STILL_0X.includes(relative(REPO, file)));

const COMMANDS = readCommandTree(readFileSync(join(REPO, 'scripts', 'cli-1.0-commands.txt'), 'utf8'));
const MCP_GUIDES = markdownUnder(join(REPO, 'mcp'));
const VERIFIED_GUIDES = ['billing-prompt.md', 'feature-flags-prompt.md'];
const VERIFY_INTRO = 'Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run.';

describe('the 1.0 guides teach only what 1.0 has (TBP-292, TBP-355)', () => {
  it('names no 0.x setting, 0.x API, old server or retired wording outside upgrade notes', () => {
    const found = CURRENT_GUIDES.flatMap((file) => bannedNames(readFileSync(file, 'utf8')).map((v) => `${relative(REPO, file)}:${v.line} — ${v.rule}: ${v.text}`));
    expect(found).toEqual([]);
  });

  it('names only CLI 1.0 commands and their options', () => {
    expect(COMMANDS.size).toBeGreaterThan(50);
    const found = CURRENT_GUIDES.flatMap((file) => unknownCommands(readFileSync(file, 'utf8'), COMMANDS).map((v) => `${relative(REPO, file)}:${v.line} — ${v.rule}: ${v.text}`));
    expect(found).toEqual([]);
  });

  it('the 0.x allowance only shrinks: every listed page exists and still fails a 1.0 check', () => {
    for (const name of LEARNING_STILL_0X) {
      const md = readFileSync(join(REPO, name), 'utf8');
      expect({ name, stillOld: bannedNames(md).length + unknownCommands(md, COMMANDS).length > 0 }).toEqual({ name, stillOld: true });
    }
    expect(CURRENT_GUIDES.some((file) => file.includes(`${join('learning', 'plan-limits')}`))).toBe(true);
  });

  it('has the five 1.0 guides the readers fetch', () => {
    const names = MCP_GUIDES.map((file) => relative(join(REPO, 'mcp'), file)).sort();
    expect(names).toEqual(['auth-prompt.md', 'billing-prompt.md', 'feature-flags-prompt.md', 'integration-prompt.md', 'team-prompt.md']);
  });

  it('installs the plugin from the alpha tag and names its three settings', () => {
    const integration = readFileSync(join(REPO, 'mcp', 'integration-prompt.md'), 'utf8');
    expect(integration).toContain('@nebulr-group/bridge-nestjs@alpha');
    for (const setting of ['BRIDGE_ISSUER', 'BRIDGE_APP_KEY', 'BRIDGE_WEBHOOK_SECRETS']) expect(integration).toContain(setting);
  });
});

describe('the billing and flag guides split their checks (TBP-812)', () => {
  it.each(VERIFIED_GUIDES)('%s has terminal checks, browser checks and the Heads up rule', (name) => {
    const md = readFileSync(join(REPO, 'mcp', name), 'utf8');
    const verify = md.slice(md.indexOf('## Verify'));
    expect(md.includes('## Verify')).toBe(true);
    expect(verify).toContain('### Terminal checks');
    expect(verify).toContain('### Browser checks');
    expect(verify).toContain(VERIFY_INTRO);
    expect(verify).toContain('Heads up: not verified in a browser');
    expect(verify).toMatch(/### Browser checks\s+1\. /);
    expect(verify).toContain('check gates');
  });

  it('the billing guide calls the limited handler at the limit and names the real refusal', () => {
    const verify = readFileSync(join(REPO, 'mcp', 'billing-prompt.md'), 'utf8').split('## Verify')[1];
    expect(verify).toContain('`bridge plan list`');
    expect(verify).toContain('`bridge stripe status`');
    expect(verify).toContain('"code": "QUOTA_EXCEEDED"');
    expect(verify).toContain('402');
  });
});

describe('the 1.0 checks themselves', () => {
  it('go red on planted 0.x names and retired wordings', () => {
    const planted = [
      'BRIDGE_API_BASE_URL=https://api.thebridge.dev',
      'Set `BRIDGE_APP_ID` in the environment.',
      'Run `bridge app update --ui-url https://app.example.com/auth`.',
      'Purchasing lives in bridge-api.',
      "@CurrentUser() user: BridgeUser",
      "BridgeFlagsModule.forRoot({ runtimeMode: 'pull' })",
      "The frontend's quota display is decoration.",
      'The server is authoritative; the client is decorative.',
      'Counting in the browser is display only.',
      'The agent verifies — do not hand this to the developer.',
    ];
    for (const line of planted) expect({ line, flagged: bannedNames(`# Guide\n\n${line}\n`).length > 0 }).toEqual({ line, flagged: true });
  });

  it('let upgrade notes name the old names', () => {
    expect(bannedNames('## Upgrading from 0.x\n\n| `@CurrentUser()` | `@CurrentActor()` |\n\n## Next\n\nok\n')).toEqual([]);
  });

  it('go red on a command or option CLI 1.0 does not have', () => {
    const planted = ['Run `bridge app redirect-uris add https://x`.', '```bash\nbridge plan quota set pro --metric tickets --limit 3\n```', '`bridge flag create beta --rule-json x`', '`npx @nebulr-group/bridge-cli@alpha checks gates`'];
    for (const md of planted) expect({ md, flagged: unknownCommands(md, COMMANDS).length > 0 }).toEqual({ md, flagged: true });
  });

  it('stay green on real CLI 1.0 commands', () => {
    const fine = [
      '`bridge plan limit set free tickets=3`',
      '`npx @nebulr-group/bridge-cli@alpha check gates`',
      '```bash\nbridge flag create reports --when "privileges contains reports:read" --rollout 25\nbridge app address add https://app.example.com --use browser-origin\n```',
      '`bridge guide nestjs billing`',
      '`bridge --app app_1 plan list`',
    ];
    for (const md of fine) expect({ md, found: unknownCommands(md, COMMANDS) }).toEqual({ md, found: [] });
  });
});
