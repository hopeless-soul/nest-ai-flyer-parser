import type { SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * OpenAPI schema of what a zod schema accepts, for `@ApiBody({ schema })`.
 * Keeps zod the single source of truth for request shapes; refinements are not represented.
 */
export function zodSchema(schema: z.ZodType): SchemaObject {
  return z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
  }) as SchemaObject;
}
