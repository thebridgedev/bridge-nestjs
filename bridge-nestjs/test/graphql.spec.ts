import { HttpException, type INestApplication } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { BridgeAuthGuard, Public, RequireFlag, type RouteRule } from '../src';
import { createSignedIssuer, type SignedIssuer } from './support/signed-issuer';
import { startApp } from './support/test-app';

/** Resolvers as `@nestjs/graphql` would call them: the guard sees `[root, args, context, info]`. */
class CatalogResolver {
  catalog() {}
  secrets() {}
  reports() {}
  @RequireFlag('reports')
  decoratedReports() {}
  @Public()
  decoratedOpen() {}
}

const RULES: RouteRule[] = [
  { graphqlField: 'Query.catalog', privilege: 'ANONYMOUS' },
  { graphqlField: 'Query.reports', privilege: 'AUTHENTICATED', featureFlag: 'reports' },
  // A path rule never reaches a resolver: GraphQL calls all share one URL.
  { path: '/graphql', privilege: 'ANONYMOUS' },
];

describe('GraphQL rules match the resolver, never the operation name', () => {
  let issuer: SignedIssuer;
  let app: INestApplication;
  let guard: BridgeAuthGuard;
  let token: string;

  beforeEach(async () => {
    issuer = await createSignedIssuer();
    app = await startApp(issuer, { guard: { global: true, rules: RULES } });
    guard = app.get(BridgeAuthGuard);
    token = await issuer.personToken();
  });

  afterEach(async () => {
    await app.close();
  });

  /** One field of a document, as the GraphQL executor resolves it. */
  const field = (operation: string | undefined, type: string, name: keyof CatalogResolver, bearer?: string) => {
    const req = { method: 'POST', originalUrl: '/graphql', headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` } };
    const info = { operation: { name: operation === undefined ? undefined : { value: operation } }, parentType: { name: type }, fieldName: name };
    const context = new ExecutionContextHost([{}, {}, { req }, info], CatalogResolver, CatalogResolver.prototype[name]);
    context.setType('graphql');
    return context;
  };

  /** The status the guard answers with: 200 when it lets the field through. */
  const status = async (context: ExecutionContextHost): Promise<number> => {
    try {
      return (await guard.canActivate(context)) ? 200 : 0;
    } catch (error) {
      if (error instanceof HttpException) return error.getStatus();
      throw error;
    }
  };

  it('opens a field by its resolver, whatever the operation is called', async () => {
    expect(await status(field('PublicCatalog', 'Query', 'catalog'))).toBe(200);
    expect(await status(field('Anything', 'Query', 'catalog'))).toBe(200);
    expect(await status(field(undefined, 'Query', 'catalog'))).toBe(200);
  });

  it('cannot open a protected field by naming the operation after an open one', async () => {
    for (const name of ['PublicCatalog', 'catalog', 'Query.catalog', undefined]) {
      expect({ name, status: await status(field(name, 'Query', 'secrets')) }).toEqual({ name, status: 401 });
    }
  });

  it('checks each field of a multi-field or multi-operation document on its own', async () => {
    // `query catalog { catalog secrets }` and a batch of `query A { catalog }` + `query catalog { secrets }`:
    // the executor resolves each field, and each field's resolver brings its own check.
    expect(await status(field('catalog', 'Query', 'catalog'))).toBe(200);
    expect(await status(field('catalog', 'Query', 'secrets'))).toBe(401);
    expect(await status(field('A', 'Query', 'catalog'))).toBe(200);
    expect(await status(field('catalog', 'Query', 'secrets', token))).toBe(200);
  });

  it('matches the parent type too: Mutation.catalog is not Query.catalog', async () => {
    expect(await status(field('PublicCatalog', 'Mutation', 'catalog'))).toBe(401);
  });

  it('cannot skip a flag gate by renaming the operation', async () => {
    for (const name of ['Reports', 'NotReports', 'catalog', undefined]) {
      expect({ name, status: await status(field(name, 'Query', 'reports', token)) }).toEqual({ name, status: 403 });
    }
    issuer.setFlags('user-alice', [{ key: 'reports', value: true }]);
    expect(await status(field('Whatever', 'Query', 'reports', token))).toBe(200);
  });

  it('takes decorators on the resolver', async () => {
    expect(await status(field('X', 'Query', 'decoratedOpen'))).toBe(200);
    expect(await status(field('X', 'Query', 'decoratedReports', token))).toBe(403);
  });

  it('refuses to start with an operation-name rule or a field that is not Type.field', async () => {
    await expect(startApp(issuer, { guard: { global: true, rules: [{ graphqlOperation: 'PublicCatalog', privilege: 'ANONYMOUS' } as RouteRule] } })).rejects.toThrow(/graphqlOperation/);
    await expect(startApp(issuer, { guard: { global: true, rules: [{ graphqlField: 'catalog', privilege: 'ANONYMOUS' }] } })).rejects.toThrow(/Type\.field/);
  });
});
