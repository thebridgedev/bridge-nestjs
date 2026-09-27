import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  const port = process.env.PORT || 3000;
  await app.listen(port);
  
  console.log(`🚀 Demo app running on http://localhost:${port}`);
  console.log(`
Available endpoints:
  GET  /health          - Public health check
  GET  /items           - Protected: requires authentication
  GET  /admin/users     - Protected: requires ADMIN role
  GET  /admin/settings  - Protected: requires OWNER role
  GET  /beta/feature    - Protected: requires 'beta-access' feature flag
  GET  /premium/reports - Protected: requires all of 'premium-tier' and 'active-subscription' flags
  GET  /forward/items   - Protected: forwards token to GET /items via BridgeHttpService
  POST /tickets             - Plan limit (gauge): 402 at the 'tickets' quota
  DELETE /tickets/:id       - Keeps the 'tickets' gauge in step
  POST /tickets/:id/export  - Plan limit (counter) on 'exports' + 'app_active' entitlement
`);
}

bootstrap();

