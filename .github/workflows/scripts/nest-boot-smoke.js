// Boots a real Nest app with the Bridge guard: a @Public() route answers 200,
// a protected one 401, both under a global prefix (TBP-760, TBP-540).
require('reflect-metadata');
const { Module, Controller, Get } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { BridgeModule, Public } = require('@nebulr-group/bridge-nestjs');

class AppController {
  health() { return { ok: true }; }
  secret() { return { secret: true }; }
}
const method = (name, ...decorators) => {
  const descriptor = Object.getOwnPropertyDescriptor(AppController.prototype, name);
  for (const d of decorators) d(AppController.prototype, name, descriptor);
};
method('health', Get('health'), Public());
method('secret', Get('secret'));
Controller()(AppController);

class AppModule {}
Module({
  imports: [BridgeModule.forRoot({ appId: 'install-smoke', guard: { global: true, defaultAccess: 'protected' } })],
  controllers: [AppController],
})(AppModule);

(async () => {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix('api');
  await app.listen(0);
  const base = await app.getUrl();
  const health = await fetch(`${base}/api/health`);
  const secret = await fetch(`${base}/api/secret`);
  await app.close();
  console.log(`health=${health.status} secret=${secret.status}`);
  if (health.status !== 200 || secret.status !== 401) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
