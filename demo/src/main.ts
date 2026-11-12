import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: webhook signatures are checked over the body exactly as it arrived.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(Number(process.env.PORT ?? 3000));
}
void bootstrap();
