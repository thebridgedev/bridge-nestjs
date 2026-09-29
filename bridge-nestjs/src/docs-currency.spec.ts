// TBP-705 — no agent-facing guide in this repo may teach a direct role,
// privilege, plan or plan-feature check (owner rule 2026-09-29: every gate in
// app code is a flag; its rule says why).
//
// Scans mcp/*.md, learning/**/*.md and both READMEs. Lines inside a section
// whose heading says "Exceptions" are exempt, and so is a sentence that tells
// the reader NOT to do the thing (never / instead of / rather than / do not).
//
// The pattern list and the scanner below MIRROR bridge-cli
// `src/gate-rules.ts` (DOC_FORBIDDEN / docGateViolations), which is the
// source of truth — `bridge check gates` flags the same code in the
// developer's app. Keep the two the same when either changes.

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
const NESTJS_LINE = "an endpoint is `@RequireFeatureFlag('…')` on the handler";

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
    const entryGuides = GUIDES.filter((f) => /[/\\]mcp[/\\]|README\.md$/.test(f) && !/[/\\]learning[/\\](?!README)/.test(f));
    expect(entryGuides.length).toBeGreaterThan(3);
    const missing = entryGuides.filter((file) => {
      const md = readFileSync(file, 'utf8');
      const h2 = md.split('\n').find((l) => /^## /.test(l));
      return h2 !== RULE_HEADING || !md.includes(NESTJS_LINE) || !md.includes('npx @nebulr-group/bridge-cli check gates');
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
