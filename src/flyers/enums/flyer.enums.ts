export enum FlyerStatus {
  // Entry created from the listing
  Downloading = 'DOWNLOADING',
  // Pages uploaded to R2 & FlyerPages table
  PagesUploaded = 'PAGES_UPLOADED',

  // AI parsing
  Parsing = 'PARSING',

  // All pages parsed
  Ready = 'READY',
  // Partial parsed with up to `maxFailedPages` failed pages
  Partial = 'PARTIAL',
  // Failed to parse
  Failed = 'FAILED',
}

export const PARSED = [FlyerStatus.Ready, FlyerStatus.Partial];
export const RESUMABLE = [FlyerStatus.PagesUploaded, FlyerStatus.Parsing];
