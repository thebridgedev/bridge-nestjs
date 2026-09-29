import 'reflect-metadata';
import { BridgeConfigService, BRIDGE_CONFIG } from './bridge-config.service';
import { BRIDGE_DEFAULTS } from '../types/config';

function makeService(overrides: Record<string, any> = {}): BridgeConfigService {
  const config = {
    appId: 'test-app',
    ...overrides,
  };
  // Simulate Inject() by passing config directly
  return new BridgeConfigService(config as any);
}

describe('BridgeConfigService', () => {
  describe('defaults', () => {
    it('should derive authBaseUrl from default apiBaseUrl', () => {
      const svc = makeService();
      expect(svc.authBaseUrl).toBe(`${BRIDGE_DEFAULTS.apiBaseUrl}/auth`);
    });

    it('should derive cloudViewsBaseUrl from default apiBaseUrl', () => {
      const svc = makeService();
      expect(svc.cloudViewsBaseUrl).toBe(`${BRIDGE_DEFAULTS.apiBaseUrl}/cloud-views`);
    });

    it('should default debug to false', () => {
      const svc = makeService();
      expect(svc.debug).toBe(false);
    });

    it('should default isGlobalGuard to false when guard not set', () => {
      const svc = makeService();
      expect(svc.isGlobalGuard).toBe(false);
    });

    it('should default defaultAccess to protected', () => {
      const svc = makeService();
      expect(svc.defaultAccess).toBe('protected');
    });
  });

  describe('jwksUrl', () => {
    it('should derive jwksUrl from apiBaseUrl', () => {
      const svc = makeService({ apiBaseUrl: 'https://api.example.com' });
      expect(svc.jwksUrl).toBe('https://api.example.com/auth/.well-known/jwks.json');
    });

    it('should use userJwksUrl override when provided', () => {
      const svc = makeService({ userJwksUrl: 'http://host.docker.internal:3200/auth/.well-known/jwks.json' });
      expect(svc.jwksUrl).toBe('http://host.docker.internal:3200/auth/.well-known/jwks.json');
    });
  });

  describe('findMatchingRule', () => {
    const rules = [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/admin/*', privilege: 'AUTHENTICATED', featureFlag: 'admin-area' },
      { path: '/items', privilege: 'AUTHENTICATED' },
    ];
    let svc: BridgeConfigService;

    beforeEach(() => {
      svc = makeService({ guard: { rules } });
    });

    it('should return exact match', () => {
      const rule = svc.findMatchingRule('/health', 'GET');
      expect(rule).not.toBeNull();
      expect(rule!.path).toBe('/health');
    });

    it('should return wildcard match', () => {
      const rule = svc.findMatchingRule('/admin/users', 'GET');
      expect(rule).not.toBeNull();
      expect(rule!.path).toBe('/admin/*');
    });

    it('should match path regardless of method', () => {
      const rule = svc.findMatchingRule('/items', 'GET');
      expect(rule).not.toBeNull();

      const rule2 = svc.findMatchingRule('/items', 'POST');
      expect(rule2).not.toBeNull();
    });

    it('should return null when no rule matches', () => {
      const rule = svc.findMatchingRule('/unknown/path', 'GET');
      expect(rule).toBeNull();
    });
  });

  describe('pathMatches (via findMatchingRule)', () => {
    let svc: BridgeConfigService;

    beforeEach(() => {
      svc = makeService({
        guard: {
          rules: [
            { path: '/exact', privilege: 'ANONYMOUS' },
            { path: '/wildcard/*', privilege: 'ANONYMOUS' },
            { path: 'no-leading-slash', privilege: 'ANONYMOUS' },
          ],
        },
      });
    });

    it('should match exact paths', () => {
      expect(svc.findMatchingRule('/exact', 'GET')).not.toBeNull();
    });

    it('should match wildcard patterns', () => {
      expect(svc.findMatchingRule('/wildcard/foo', 'GET')).not.toBeNull();
      expect(svc.findMatchingRule('/wildcard/foo/bar', 'GET')).not.toBeNull();
    });

    it('should not match when path differs', () => {
      expect(svc.findMatchingRule('/other', 'GET')).toBeNull();
    });

    it('should handle pattern without leading slash', () => {
      expect(svc.findMatchingRule('/no-leading-slash', 'GET')).not.toBeNull();
    });
  });

  // TBP-705 — every gate is a flag. A rule that still gates on a role,
  // privilege, plan or entitlement stops the app at startup and names the flag
  // setup to use instead; silently ignoring it would open the route.
  describe('route rules that gate some other way fail at startup (TBP-705)', () => {
    const rulesOf = (...rules: Record<string, unknown>[]) => ({ guard: { rules } });

    it('accepts ANONYMOUS / AUTHENTICATED rules with or without a featureFlag', () => {
      expect(() =>
        makeService(
          rulesOf(
            { path: '/health', privilege: 'ANONYMOUS' },
            { path: '/items', privilege: 'AUTHENTICATED' },
            { path: '/admin/*', privilege: 'AUTHENTICATED', featureFlag: 'admin-area' },
          ),
        ),
      ).not.toThrow();
    });

    it('a privilege key names the flag rule and @RequirePrivilege for API tokens', () => {
      expect(() => makeService(rulesOf({ path: '/admin/*', privilege: 'TENANT_WRITE' }))).toThrow(
        /guard\.rules\[0\] \(path '\/admin\/\*'\) has privilege: "TENANT_WRITE".*featureFlag: '<flag-key>'.*privileges contains "TENANT_WRITE".*@RequirePrivilege\("TENANT_WRITE"\) on the handler \(API tokens only\)/s,
      );
    });

    it('`plans` names a flag on the plan feature', () => {
      expect(() =>
        makeService(rulesOf({ path: '/reports/*', privilege: 'AUTHENTICATED', plans: ['pro'] })),
      ).toThrow(/uses `plans`, which was removed\. Use featureFlag: '<flag-key>'.*bridge:billing\.entitlement\.<key> eq true/s);
    });

    it('`entitlement` names the flag with the same key', () => {
      expect(() =>
        makeService(rulesOf({ path: '/export', privilege: 'AUTHENTICATED', entitlement: 'export' })),
      ).toThrow(/uses `entitlement`, which was removed\. Use featureFlag: 'export'.*bridge:billing\.entitlement\.export eq true/s);
    });

    it('`role` is refused too', () => {
      expect(() =>
        makeService(rulesOf({ graphqlOperation: 'listUsers', privilege: 'AUTHENTICATED', role: 'ADMIN' })),
      ).toThrow(/guard\.rules\[0\] \(graphqlOperation 'listUsers'\) uses `role`/);
    });

    it('lists every offending rule in one error, and points at the gate check', () => {
      let message = '';
      try {
        makeService(
          rulesOf(
            { path: '/a', privilege: 'USER_READ' },
            { path: '/ok', privilege: 'ANONYMOUS' },
            { path: '/b', privilege: 'AUTHENTICATED', plans: ['pro'] },
          ),
        );
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("guard.rules[0] (path '/a')");
      expect(message).toContain("guard.rules[2] (path '/b')");
      expect(message).not.toContain('rules[1]');
      expect(message).toContain('npx @nebulr-group/bridge-cli check gates');
    });
  });

  describe('log', () => {
    it('should log when debug is true', () => {
      const svc = makeService({ debug: true });
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      svc.log('test message');
      expect(spy).toHaveBeenCalledWith('[Bridge] test message');
      spy.mockRestore();
    });

    it('should not log when debug is false', () => {
      const svc = makeService({ debug: false });
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      svc.log('test message');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
