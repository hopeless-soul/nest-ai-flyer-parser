import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

/**
 * Validate a body, query or param with a zod schema; 400 with readable issues on failure
 * Usage: `@Body(new ZodValidationPipe(schema)) body: z.infer<typeof schema>`
 */
@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  /** @param schema - Schema the incoming value must match */
  constructor(private readonly schema: T) {}

  /** Parse `value`; returns the schema output (defaults applied, unknown keys handled by the schema) */
  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(z.prettifyError(result.error));
    }
    return result.data;
  }
}
