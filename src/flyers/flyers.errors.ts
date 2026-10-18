/** A flyer or page a pipeline run needs does not exist (or the shop has no current flyer) */
export class FlyerNotFoundError extends Error {
  /** @param message - What was missing */
  constructor(message: string) {
    super(message);
    this.name = 'FlyerNotFoundError';
  }
}
