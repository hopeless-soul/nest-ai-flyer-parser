import { Test } from '@nestjs/testing';
import { SHOP_CONFIGS } from '../shops/shop.config';
import type { ShopConfigs } from '../shops/shop.config.type';
import { FlyerHttpService, HttpRequestError } from './http/flyer-http.service';
import { ShopConfigOverrideError } from './page-provider.errors';
import { PageProvidersModule } from './page-providers.module';
import { PageProvidersService } from './page-providers.service';
import { SHOP_CONFIGS_TOKEN } from './page-providers.tokens';

const KAUFLAND_HTML = `<div data-t-name="FlyerTile" data-subcategory="KDZ"
  data-download-url="https://media.kaufland.com/kdz.pdf">
  <span class="m-flyer-tile__validity-date">15.10.2026 – 21.10.2026</span></div>`;

async function setup(configs: ShopConfigs = SHOP_CONFIGS) {
  const http = {
    getText: jest.fn(),
    getJson: jest.fn(),
    downloadToFile: jest.fn(),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [PageProvidersModule],
  })
    .overrideProvider(FlyerHttpService)
    .useValue(http)
    .overrideProvider(SHOP_CONFIGS_TOKEN)
    .useValue(configs)
    .compile();
  await moduleRef.init();
  return { service: moduleRef.get(PageProvidersService), http };
}

describe('PageProvidersService', () => {
  it('resolves a shop through its provider, wired by Nest DI', async () => {
    const { service, http } = await setup();
    http.getText.mockResolvedValue(KAUFLAND_HTML);

    const flyer = await service.resolve('kaufland');
    expect(flyer.flyerId).toBe('kaufland_2026-10-15_2026-10-21');
  });

  it('applies overrides for one call only', async () => {
    const { service, http } = await setup();
    http.getText.mockResolvedValue(KAUFLAND_HTML.replace('KDZ', 'SPECIAL'));
    const flyerUrl =
      'https://predajne.kaufland.sk/aktualna-ponuka/specialny-letak.html';

    const overrides = service.parseOverrides('kaufland', {
      source: { flyerUrl, flyerSubcategory: 'SPECIAL' },
      defaultFlyerDuration: 14,
    });
    await service.resolve('kaufland', overrides);

    expect(http.getText).toHaveBeenCalledWith(flyerUrl);
    expect(service.getConfig('kaufland', overrides)).toMatchObject({
      defaultFlyerDuration: 14,
      source: { flyerUrl, flyerSubcategory: 'SPECIAL' },
    });
    expect(service.getConfig('kaufland')).toEqual(SHOP_CONFIGS.kaufland);
  });

  it.each([
    [
      'a URL on another host',
      { source: { flyerUrl: 'https://evil.example.com/letak.html' } },
      'source.flyerUrl',
    ],
    [
      'a plain http URL',
      { source: { flyerUrl: 'http://predajne.kaufland.sk/x.html' } },
      'source.flyerUrl',
    ],
    [
      'an unknown source key',
      { source: { apiUrl: 'https://predajne.kaufland.sk/api' } },
      'source',
    ],
    ['an unknown top-level key', { enabled: false }, '(body)'],
    ['an unknown time zone', { timezone: 'Mars/Olympus' }, 'timezone'],
  ])('rejects %s', async (_case, body, path) => {
    const { service } = await setup();
    try {
      service.parseOverrides('kaufland', body);
      throw new Error('expected parseOverrides to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ShopConfigOverrideError);
      expect(
        (error as ShopConfigOverrideError).issues.map((issue) => issue.path),
      ).toContain(path);
    }
  });

  it('resolveMany keeps going after a failing shop', async () => {
    const { service, http } = await setup();
    http.getText.mockImplementation((url: string) =>
      url.includes('kaufland')
        ? Promise.resolve(KAUFLAND_HTML)
        : Promise.reject(new HttpRequestError(url, 503, 'site down')),
    );

    const results = await service.resolveMany(['tesco', 'kaufland']);
    expect(results).toEqual([
      { shop: 'tesco', ok: false, error: 'site down' },
      expect.objectContaining({ shop: 'kaufland', ok: true }),
    ]);
  });

  it('enabledShops follows SHOP_CONFIGS.enabled', async () => {
    const { service } = await setup({
      ...SHOP_CONFIGS,
      billa: { ...SHOP_CONFIGS.billa, enabled: false },
    });
    expect(service.enabledShops()).toEqual(['kaufland', 'tesco', 'lidl']);
  });

  it('fails at boot when a shop config is invalid', async () => {
    const broken = {
      ...SHOP_CONFIGS,
      lidl: {
        ...SHOP_CONFIGS.lidl,
        source: { ...SHOP_CONFIGS.lidl.source, apiUrl: 'not a url' },
      },
    };
    await expect(setup(broken)).rejects.toThrow(
      /Invalid SHOP_CONFIGS\.lidl\.source/,
    );
  });
});
