import { BillaPageProvider } from './billa.page-provider';
import { KauflandPageProvider } from './kaufland.page-provider';
import { LidlPageProvider } from './lidl.page-provider';
import { TescoPageProvider } from './tesco.page-provider';

/** A new shop: add its class here, its key to ShopKeys and its entry to SHOP_CONFIGS */
export const PAGE_PROVIDER_CLASSES = [
  KauflandPageProvider,
  TescoPageProvider,
  LidlPageProvider,
  BillaPageProvider,
];
