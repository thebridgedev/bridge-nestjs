import { Test } from '@nestjs/testing';
import { BridgeModule, resolveBridgeOptions } from '../src';

describe('module settings', () => {
  it('reads what is not given from the environment', () => {
    const env = { BRIDGE_ISSUER: 'https://bridge.example.test/identity-access/apps/app-acme', BRIDGE_APP_KEY: 'k', BRIDGE_WEBHOOK_SECRETS: 'whsec_new, whsec_old' };
    expect(resolveBridgeOptions({}, env)).toEqual({ issuer: env.BRIDGE_ISSUER, appKey: 'k', webhookSecrets: ['whsec_new', 'whsec_old'] });
    expect(resolveBridgeOptions({ issuer: 'https://other.example.test', appKey: 'given' }, env)).toMatchObject({ issuer: 'https://other.example.test', appKey: 'given' });
  });

  it('refuses to start without an issuer', async () => {
    const previous = process.env.BRIDGE_ISSUER;
    delete process.env.BRIDGE_ISSUER;
    try {
      await expect(Test.createTestingModule({ imports: [BridgeModule.forRoot()] }).compile()).rejects.toThrow(/BRIDGE_ISSUER/);
    } finally {
      if (previous !== undefined) process.env.BRIDGE_ISSUER = previous;
    }
  });
});
