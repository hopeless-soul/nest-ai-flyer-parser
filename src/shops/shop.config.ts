import type { ShopConfigs } from './shop.config.type';

const PAGES = {
  compress: { format: 'webp', quality: 60, maxWidth: 800 },
  pdfScale: 2,
} as const;

const PARSER = {
  concurrency: 4,
  maxAttempts: 4,
  maxFailedPages: 3,
};

const base = {
  enabled: true,
  timezone: 'Europe/Bratislava',
  defaultFlyerDuration: 7,
  pages: PAGES,
  parser: PARSER,
};

export const SHOP_CONFIGS: ShopConfigs = {
  kaufland: {
    ...base,
    key: 'kaufland',
    name: 'Kaufland',
    source: {
      flyerUrl: 'https://predajne.kaufland.sk/aktualna-ponuka/letak.html',
      flyerSubcategory: 'KDZ',
    },
  },
  tesco: {
    ...base,
    key: 'tesco',
    name: 'Tesco',
    source: {
      flyerUrl: 'https://www.tesco.sk/akciove-ponuky/letaky-a-katalogy',
      flyerType: 'HM',
      pages: 'pdf',
    },
  },
  lidl: {
    ...base,
    key: 'lidl',
    name: 'Lidl',
    source: {
      flyerUrl: 'https://www.lidl.sk/c/online-letak/s10008489',
      apiUrl: 'https://endpoints.leaflets.schwarz/v4/flyer',
      regionId: 0,
      imageVariant: 'image',
      pages: 'images',
    },
  },
  billa: {
    ...base,
    key: 'billa',
    name: 'Billa',
    source: {
      flyerUrl:
        'https://www.billa.sk/letaky-a-akcie%2Fletaky?tab=letaky-a-akcie/aktualny-letak',
    },
  },
};
