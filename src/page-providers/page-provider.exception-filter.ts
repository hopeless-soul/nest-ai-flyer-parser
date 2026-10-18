import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { HttpRequestError } from './http/flyer-http.service';
import {
  PageProviderError,
  ShopConfigOverrideError,
} from './page-provider.errors';

/** Domain errors → HTTP: bad overrides are the caller's fault (400), a shop site failing is upstream (502) */
@Catch(ShopConfigOverrideError, PageProviderError, HttpRequestError)
export class PageProviderExceptionFilter implements ExceptionFilter {
  catch(
    error: ShopConfigOverrideError | PageProviderError | HttpRequestError,
    host: ArgumentsHost,
  ): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (error instanceof ShopConfigOverrideError) {
      res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Invalid overrides',
        shop: error.shop,
        issues: error.issues,
      });
      return;
    }

    res.status(HttpStatus.BAD_GATEWAY).json(
      error instanceof HttpRequestError
        ? {
            statusCode: HttpStatus.BAD_GATEWAY,
            error: 'Shop site request failed',
            message: error.message,
            url: error.url,
            upstreamStatus: error.status,
          }
        : {
            statusCode: HttpStatus.BAD_GATEWAY,
            error: 'Unexpected shop page',
            shop: error.shop,
            message: error.message,
          },
    );
  }
}
