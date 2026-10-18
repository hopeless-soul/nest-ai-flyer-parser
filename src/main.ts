import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { resolveAppMode } from './app-mode';
import { AppModule } from './app.module';

// Note: APP_MODE is needed before ConfigModule reads .env; real env vars still win
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file (production, CI)
}

/** Start the process in the role selected by APP_MODE */
async function bootstrap(): Promise<void> {
  const mode = resolveAppMode();
  const logger = new Logger('Bootstrap');

  if (mode === 'worker') {
    // Note: No HTTP server; the cron jobs keep the process alive
    const app = await NestFactory.createApplicationContext(
      AppModule.forMode(mode),
    );
    app.enableShutdownHooks();
    logger.log('Worker running');
    return;
  }

  const app = await NestFactory.create(AppModule.forMode(mode));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
  logger.log(
    `${mode === 'all' ? 'API + worker' : 'API'} listening on ${await app.getUrl()}`,
  );
}

bootstrap().catch((error) => {
  new Logger('Bootstrap').error(error);
  process.exit(1);
});
