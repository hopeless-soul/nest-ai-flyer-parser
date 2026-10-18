/**
 * The model answered, but not with the expected JSON shape
 * Note: Retryable, the next attempt usually returns valid JSON
 */
export class InvalidResponseError extends Error {
  override name = 'InvalidResponseError';
}

/**
 * An error every other page would hit too (bad API key, invalid request, ...)
 * Note: Stops the whole parse run instead of failing page by page
 */
export class FatalParseError extends Error {
  override name = 'FatalParseError';
}

/** A page image is gone from R2 (expired by the lifecycle rule) or was never uploaded */
export class ImagesExpiredError extends Error {
  override name = 'ImagesExpiredError';

  /** @param pageId - Page whose image is missing */
  constructor(readonly pageId: string) {
    super(
      `Image of ${pageId} is not in R2 (expired or never uploaded); use refresh to download the flyer again`,
    );
  }
}
