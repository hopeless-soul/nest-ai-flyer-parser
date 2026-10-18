import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { resolveAppMode } from './app-mode';

// APP_MODE is needed before Nest's ConfigModule reads .env; real env vars still win
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file (Railway, CI)
}

async function bootstrap() {
  const mode = resolveAppMode();
  const logger = new Logger('Bootstrap');

  if (mode === 'worker') {
    // No HTTP server: cron jobs keep the process alive
    const app = await NestFactory.createApplicationContext(AppModule.forMode(mode));
    app.enableShutdownHooks();
    logger.log('Worker running');
    return;
  }

  const app = await NestFactory.create(AppModule.forMode(mode));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
  logger.log(`${mode === 'all' ? 'API + worker' : 'API'} listening on ${await app.getUrl()}`);
}

bootstrap().catch((error) => {
  new Logger('Bootstrap').error(error);
  process.exit(1);
});
