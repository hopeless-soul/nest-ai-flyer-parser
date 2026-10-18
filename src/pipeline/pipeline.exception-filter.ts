import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { FlyerNotFoundError } from '../flyers/flyers.errors';
import { ImagesExpiredError } from '../page-parser/page-parser.errors';
import { LeaseBusyError } from '../shops/shop-lease.service';

/** Pipeline trigger errors → HTTP: busy shop 409, expired images 410, missing flyer/page 404 */
@Catch(LeaseBusyError, ImagesExpiredError, FlyerNotFoundError)
export class PipelineExceptionFilter implements ExceptionFilter {
  /** Write the JSON error response */
  catch(
    error: LeaseBusyError | ImagesExpiredError | FlyerNotFoundError,
    host: ArgumentsHost,
  ): void {
    const status =
      error instanceof LeaseBusyError
        ? HttpStatus.CONFLICT
        : error instanceof ImagesExpiredError
          ? HttpStatus.GONE
          : HttpStatus.NOT_FOUND;
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({ statusCode: status, error: error.name, message: error.message });
  }
}
