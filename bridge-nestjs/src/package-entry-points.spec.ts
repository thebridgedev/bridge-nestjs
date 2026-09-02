// TBP-613 — the documented flags import did not resolve.
//
// The NestJS feature-flags guide tells consumers to write:
//
//   import { BridgeFlagsService } from '@nebulr-group/bridge-nestjs/flags';
//
// which failed with `TS2307: Cannot find module ... or its corresponding type
// declarations`, because package.json had no `exports` map (subpaths are not
// mapped without one) and the root index deliberately does not re-export the
// flags barrel. The code was present and working; only the documented
// specifier was unreachable. A consumer hits this as the very first step of
// the guide, and the error reads as "the package does not have this feature"
// rather than "use a different path".
//
// Fixing the map alone was not enough: `bridge flag init` scaffolded the
// `/dist/flags` workaround into generated projects, and the MCP flags prompt
// documented it. We were spreading the wrong path ourselves, so both were
// changed to `/flags` in the same release.
//
// The flags barrel is auth-free on purpose — apps in standalone-FF mode must
// not pull in BridgeAuthGuard, JWKS or the HTTP client — so re-exporting it
// from the root index would defeat its reason for existing. The subpath is the
// correct fix, not a convenience.
//
// These assertions check the MAPPING against the source layout rather than
// against `dist`, so they hold in a clean checkout before any build.

import { existsSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json');

const repoRoot = join(__dirname, '..');

/** `./dist/flags/index.js` -> `src/flags/index.ts` */
const sourceFileFor = (distTarget: string): string =>
  join(
    repoRoot,
    distTarget.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'),
  );

describe('package entry points (TBP-613)', () => {
  it('declares an exports map at all', () => {
    // This is the whole bug: `"exports": null` meant no subpath resolved.
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports).not.toBeNull();
  });

  it('exposes the documented ./flags subpath', () => {
    expect(pkg.exports['./flags']).toBeDefined();
    expect(pkg.exports['./flags'].types).toBe('./dist/flags/index.d.ts');
    expect(pkg.exports['./flags'].default).toBe('./dist/flags/index.js');
  });

  it('does NOT publish a ./dist/* path as public API', () => {
    // `dist/` is a build detail. Mapping `./dist/flags` would freeze the build
    // layout into the public contract — the very fragility that made reaching
    // into it a bad workaround in the first place ("breaks the moment the
    // build layout changes").
    //
    // We were the ones spreading that path: `bridge flag init` scaffolded
    // `@nebulr-group/bridge-nestjs/dist/flags` into generated projects and the
    // MCP flags prompt documented it, including a troubleshooting entry
    // recommending it. Both now emit `/flags`. Blessing the workaround in the
    // exports map instead would have made a temporary bug permanent API.
    //
    // This is a deliberate breaking change for anyone still on the old path;
    // the fix on their side is one import line.
    for (const subpath of Object.keys(pkg.exports)) {
      expect(subpath).not.toMatch(/^\.\/dist\//);
    }
  });

  it('carries typesVersions so pre-exports moduleResolution still finds the types', () => {
    // TypeScript's `node`/`node10` resolution ignores `exports` entirely. A
    // consumer on that setting would still get TS2307 from the exports map
    // alone, which is the exact error this ticket is about.
    expect(pkg.typesVersions?.['*']?.flags).toEqual(['dist/flags/index.d.ts']);
  });

  it('points every export target at a real source file', () => {
    // Guards against a mapping that looks right and resolves to nothing —
    // which is indistinguishable from the original bug at the consumer end.
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (subpath === './package.json') continue;
      const distTarget = (target as { default: string }).default;
      expect(existsSync(sourceFileFor(distTarget))).toBe(true);
    }
  });

  it('does not re-export the flags barrel from the root index', () => {
    // The root entry pulls in BridgeAuthGuard, JWKS and the HTTP client. The
    // flags entry exists precisely to avoid that, so a well-meaning
    // "just re-export it from index" would silently undo the split.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rootIndex = require('fs').readFileSync(join(repoRoot, 'src/index.ts'), 'utf8');
    expect(rootIndex).not.toMatch(/from '\.\/flags'/);
  });
});
