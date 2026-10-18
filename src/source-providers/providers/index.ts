import { BillaSourceProvider } from './billa.source-provider';
import { KauflandSourceProvider } from './kaufland.source-provider';
import { LidlSourceProvider } from './lidl.source-provider';
import { TescoSourceProvider } from './tesco.source-provider';

/** Every provider class; a new shop: add its class here, its key to ShopKeys and its SHOP_CONFIGS entry */
export const SOURCE_PROVIDER_CLASSES = [
  KauflandSourceProvider,
  TescoSourceProvider,
  LidlSourceProvider,
  BillaSourceProvider,
];
