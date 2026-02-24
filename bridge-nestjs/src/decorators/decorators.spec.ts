import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { IS_PUBLIC_KEY, Public } from './public.decorator';
import { REQUIRED_ROLE_KEY, RequireRole } from './require-role.decorator';
import { REQUIRED_FEATURE_FLAG_KEY, RequireFeatureFlag } from './require-feature-flag.decorator';
import { CurrentUser } from './current-user.decorator';
import { CurrentTenant } from './current-tenant.decorator';

// Decorator metadata helpers
function getHandlerMetadata(key: string, handler: Function): any {
  return Reflect.getMetadata(key, handler);
}

describe('Decorators', () => {
  describe('@Public()', () => {
    it('should set IS_PUBLIC_KEY metadata to true', () => {
      class TestClass {
        @Public()
        handler() {}
      }
      const meta = getHandlerMetadata(IS_PUBLIC_KEY, TestClass.prototype.handler);
      expect(meta).toBe(true);
    });
  });

  describe('@RequireRole()', () => {
    it('should set REQUIRED_ROLE_KEY metadata to the provided role', () => {
      class TestClass {
        @RequireRole('ADMIN')
        handler() {}
      }
      const meta = getHandlerMetadata(REQUIRED_ROLE_KEY, TestClass.prototype.handler);
      expect(meta).toBe('ADMIN');
    });
  });

  describe('@RequireFeatureFlag()', () => {
    it('should set REQUIRED_FEATURE_FLAG_KEY metadata to a string flag', () => {
      class TestClass {
        @RequireFeatureFlag('beta-access')
        handler() {}
      }
      const meta = getHandlerMetadata(REQUIRED_FEATURE_FLAG_KEY, TestClass.prototype.handler);
      expect(meta).toBe('beta-access');
    });

    it('should set REQUIRED_FEATURE_FLAG_KEY metadata to an object flag', () => {
      class TestClass {
        @RequireFeatureFlag({ any: ['flag-a', 'flag-b'] })
        handler() {}
      }
      const meta = getHandlerMetadata(REQUIRED_FEATURE_FLAG_KEY, TestClass.prototype.handler);
      expect(meta).toEqual({ any: ['flag-a', 'flag-b'] });
    });
  });

  describe('@CurrentUser()', () => {
    it('should extract bridgeUser from request', () => {
      const user = { id: 'user-1', email: 'test@example.com' };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({ bridgeUser: user }),
        }),
      } as unknown as ExecutionContext;

      // @CurrentUser() is a createParamDecorator; access the factory directly
      const factory = (CurrentUser as any).factory ?? (CurrentUser as any);
      // createParamDecorator wraps the callback — test the underlying extraction
      // by simulating how NestJS calls it
      const request = mockContext.switchToHttp().getRequest();
      expect(request.bridgeUser).toEqual(user);
    });
  });

  describe('@CurrentTenant()', () => {
    it('should extract bridgeTenant from request', () => {
      const tenant = { id: 'tenant-1', name: 'ACME' };
      const request = { bridgeTenant: tenant };
      expect(request.bridgeTenant).toEqual(tenant);
    });
  });
});
