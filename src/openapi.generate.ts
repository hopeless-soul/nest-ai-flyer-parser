import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './openapi';

// Note: ConfigModule validates env when the module is defined, so `.env` (or real env vars) must exist
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file (CI): real env vars must be set
}

/** Output path of `pnpm openapi`, relative to the repo root */
const OUTPUT = 'openapi.json';

/** Write the API's OpenAPI document; preview mode builds the module graph without DB, R2 or Gemini */
async function generate(): Promise<void> {
  const app = await NestFactory.create(AppModule.forMode('api'), {
    preview: true,
    logger: false,
  });
  writeFileSync(
    OUTPUT,
    `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`,
  );
  await app.close();
  console.log(`OpenAPI document written to ${OUTPUT}`);
}

generate().catch((error) => {
  console.error(error);
  process.exit(1);
});
