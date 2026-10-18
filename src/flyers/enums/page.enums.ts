/** Lifecycle of a flyer page: registered → in R2 → parsed or failed */
export enum PageStatus {
  // Row registered, image not in R2 yet
  Pending = 'PENDING',
  // Image uploaded to R2 and linked (imageKey/imageHash set)
  Uploaded = 'UPLOADED',
  // Offers extracted by the current or an older parser version
  Parsed = 'PARSED',
  // Parsing failed after all attempts; retried by the next run
  Failed = 'FAILED',
}
