import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';

/** Security scheme name of the `X-API-Key` header; used with `@ApiSecurity` on admin controllers */
export const API_KEY_SECURITY = 'api-key';

/** Build the OpenAPI document of `app` (DTO metadata comes from the swagger CLI plugin) */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Flyer parser API')
    .setDescription(
      'Weekly flyer offers of Slovak grocery chains. Admin routes need an API key (Bearer or X-API-Key).',
    )
    .setVersion(process.env.npm_package_version ?? '0.0.1')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description: 'Admin API key (same value as X-API-Key)',
    })
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Admin API key (same value as Bearer)',
      },
      API_KEY_SECURITY,
    )
    // Note: Names must match the controllers' @ApiTags; this order is the UI order
    .addTag('public', 'Read API for the frontend: shops, current offers, pages')
    .addTag('admin: shops', 'Shop state and pipeline triggers')
    .addTag(
      'admin: source providers',
      'Source configs and dry-run discovery (nothing is stored)',
    )
    .addTag('admin: flyers', 'Parsed flyers, pages and offers; manual edits')
    .build();
  return SwaggerModule.createDocument(app, config);
}
