import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { resolveAppMode } from './app-mode';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './openapi';

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
  const docs = process.env.NODE_ENV !== 'production';
  if (docs) {
    // Note: Docs UI at /docs, JSON at /docs-json; never mounted in production
    SwaggerModule.setup('docs', app, () => buildOpenApiDocument(app), {
      swaggerOptions: { persistAuthorization: true, docExpansion: 'none' },
    });
  }
  await app.listen(process.env.PORT ?? 3000);
  const url = await app.getUrl();
  logger.log(`${mode === 'all' ? 'API + worker' : 'API'} listening on ${url}`);
  if (docs)
    logger.log(`Swagger UI: ${url}/docs · OpenAPI JSON: ${url}/docs-json`);
}

bootstrap().catch((error) => {
  new Logger('Bootstrap').error(error);
  process.exit(1);
});
