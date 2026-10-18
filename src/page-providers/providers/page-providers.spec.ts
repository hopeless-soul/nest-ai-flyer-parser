import { SHOP_CONFIGS } from '../../shops/shop.config';
import type { ShopConfig } from '../../shops/shop.config.type';
import type { FlyerHttpService } from '../http/flyer-http.service';
import { PageProviderError } from '../page-provider.errors';
import { BillaPageProvider } from './billa.page-provider';
import { KauflandPageProvider } from './kaufland.page-provider';
import { LidlPageProvider } from './lidl.page-provider';
import { TescoPageProvider } from './tesco.page-provider';

const fakeHttp = () => ({
  getText: jest.fn<Promise<string>, [string, unknown?]>(),
  getJson: jest.fn(),
});
type FakeHttp = ReturnType<typeof fakeHttp>;
const asHttp = (http: FakeHttp) => http as unknown as FlyerHttpService;

beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-18T10:00:00Z') }));
afterEach(() => jest.useRealTimers());

describe('KauflandPageProvider', () => {
  const html = `
    <div data-t-name="FlyerTile" data-subcategory="OTHER" data-download-url="https://media.kaufland.com/other.pdf">
      <span class="m-flyer-tile__validity-date">01.10.2026 – 07.10.2026</span></div>
    <div data-t-name="FlyerTile" data-subcategory="KDZ" data-aa-detail="15.10.2026 - 21.10.2026"
      data-download-url="https://media.kaufland.com/kdz.pdf?a=1&amp;b=2">
      <span class="m-flyer-tile__validity-date"></span></div>`;

  it('picks the KDZ tile, falls back to data-aa-detail and decodes the PDF url', async () => {
    const http = fakeHttp();
    http.getText.mockResolvedValue(html);
    const flyer = await new KauflandPageProvider(asHttp(http)).resolve(
      SHOP_CONFIGS.kaufland,
    );

    expect(flyer).toMatchObject({
      flyerId: 'kaufland_2026-10-15_2026-10-21',
      validToEstimated: false,
      pages: { kind: 'pdf', url: 'https://media.kaufland.com/kdz.pdf?a=1&b=2' },
    });
    expect(http.getText).toHaveBeenCalledWith(
      SHOP_CONFIGS.kaufland.source.flyerUrl,
    );
  });

  it('fails with a PageProviderError when the tile is missing', async () => {
    const http = fakeHttp();
    http.getText.mockResolvedValue('<html>redesigned</html>');
    await expect(
      new KauflandPageProvider(asHttp(http)).resolve(SHOP_CONFIGS.kaufland),
    ).rejects.toThrow(
      new PageProviderError(
        'kaufland',
        `flyer tile "KDZ" not found on ${SHOP_CONFIGS.kaufland.source.flyerUrl}`,
      ),
    );
  });
});

describe('TescoPageProvider', () => {
  const nextData = (leaflets: object[]) =>
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          __APOLLO_STATE__: Object.fromEntries(
            leaflets.map((l, i) => [`Leaflet:${i}`, l]),
          ),
        },
      },
    })}</script>`;
  const leaflet = (
    type: string,
    validFrom: string,
    validTo: string | null,
    name: string,
  ) => ({
    __typename: 'Leaflet',
    type,
    validFrom,
    validTo,
    leafletUrl: `https://tesco.sk/${name}.pdf`,
    pages: [
      { pagePNG: `https://tesco.sk/${name}-1.png` },
      { pagePNG: `https://tesco.sk/${name}-2.png` },
    ],
  });
  const html = nextData([
    leaflet(
      'HM',
      '2026-10-15T00:00:00+02:00',
      '2026-10-21T23:59:59+02:00',
      'current',
    ),
    leaflet(
      'HM',
      '2026-10-22T00:00:00+02:00',
      '2026-10-28T23:59:59+02:00',
      'next-week',
    ),
    leaflet(
      'SM',
      '2026-10-15T00:00:00+02:00',
      '2026-10-21T23:59:59+02:00',
      'supermarket',
    ),
  ]);

  it('picks the HM leaflet valid today, not next week’s', async () => {
    const http = fakeHttp();
    http.getText.mockResolvedValue(html);
    const flyer = await new TescoPageProvider(asHttp(http)).resolve(
      SHOP_CONFIGS.tesco,
    );

    expect(flyer.flyerId).toBe('tesco_2026-10-15_2026-10-21');
    expect(flyer.pages).toEqual({
      kind: 'pdf',
      url: 'https://tesco.sk/current.pdf',
    });
  });

  it('returns the page images when source.pages is images', async () => {
    const http = fakeHttp();
    http.getText.mockResolvedValue(html);
    const config: ShopConfig<'tesco'> = {
      ...SHOP_CONFIGS.tesco,
      source: { ...SHOP_CONFIGS.tesco.source, pages: 'images' },
    };
    const flyer = await new TescoPageProvider(asHttp(http)).resolve(config);

    expect(flyer.pages).toEqual({
      kind: 'images',
      urls: [
        'https://tesco.sk/current-1.png',
        'https://tesco.sk/current-2.png',
      ],
    });
  });

  it('estimates validTo from defaultFlyerDuration when the site has none', async () => {
    const http = fakeHttp();
    http.getText.mockResolvedValue(
      nextData([leaflet('HM', '2026-10-15T00:00:00+02:00', null, 'open')]),
    );
    const flyer = await new TescoPageProvider(asHttp(http)).resolve(
      SHOP_CONFIGS.tesco,
    );

    expect(flyer).toMatchObject({
      flyerId: 'tesco_2026-10-15_2026-10-22',
      validToEstimated: true,
    });
  });
});

describe('LidlPageProvider', () => {
  const listHtml = `
    <a href="/l/sk/letak/online-letak-platny-od-15-10-2026/ar/0">this week</a>
    <a href="/l/sk/letak/online-letak-platny-od-22-10-2026/ar/0">next week</a>
    <a href="/l/sk/letak/online-letak-platny-od-15-10-2026/ar/0">duplicate</a>
    <a href="/l/sk/letak/magazin-2026/ar/0">magazine</a>`;
  const api = (from: string, to: string, name: string) => ({
    success: true,
    flyer: {
      pdfUrl: `https://lidl.sk/${name}.pdf`,
      offerStartDate: from,
      offerEndDate: to,
      pages: [
        {
          number: 2,
          image: `https://lidl.sk/${name}-2.jpg`,
          zoom: `https://lidl.sk/${name}-2z.jpg`,
        },
        {
          number: 1,
          image: `https://lidl.sk/${name}-1.jpg`,
          zoom: `https://lidl.sk/${name}-1z.jpg`,
        },
      ],
    },
  });

  it('reads the list page with large headers and picks the flyer valid today', async () => {
    const http = fakeHttp();
    http.getText.mockResolvedValue(listHtml);
    http.getJson.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('15-10-2026')
          ? api('2026-10-15', '2026-10-21', 'this')
          : api('2026-10-22', '2026-10-28', 'next'),
      ),
    );
    const flyer = await new LidlPageProvider(asHttp(http)).resolve(
      SHOP_CONFIGS.lidl,
    );

    expect(http.getText).toHaveBeenCalledWith(
      SHOP_CONFIGS.lidl.source.flyerUrl,
      { maxHeaderSize: 65536 },
    );
    expect(http.getJson).toHaveBeenCalledTimes(2);
    expect(http.getJson).toHaveBeenCalledWith(
      'https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=online-letak-platny-od-15-10-2026&region_id=0',
    );
    expect(flyer).toMatchObject({
      flyerId: 'lidl_2026-10-15_2026-10-21',
      pages: {
        kind: 'images',
        urls: ['https://lidl.sk/this-1.jpg', 'https://lidl.sk/this-2.jpg'],
      },
      meta: { slug: 'online-letak-platny-od-15-10-2026' },
    });
  });

  it('skips a slug whose API call fails', async () => {
    const http = fakeHttp();
    http.getText.mockResolvedValue(listHtml);
    http.getJson.mockImplementation((url: string) =>
      url.includes('15-10-2026')
        ? Promise.reject(new Error('HTTP 500'))
        : Promise.resolve(api('2026-10-08', '2026-10-14', 'last-week')),
    );
    const flyer = await new LidlPageProvider(asHttp(http)).resolve(
      SHOP_CONFIGS.lidl,
    );

    // Note: Only last week's flyer is usable; the sync sees the same flyerId and waits
    expect(flyer.flyerId).toBe('lidl_2026-10-08_2026-10-14');
  });
});

describe('BillaPageProvider', () => {
  const html = (validity: string) =>
    `<p>Akciová ponuka platí od ${validity}</p><a href="https://view.publitas.com/billa/letak.pdf?x=1&amp;y=2">PDF</a>`;

  it('parses the validity text and the Publitas link', async () => {
    const http = fakeHttp();
    http.getText.mockResolvedValue(html('15. 10. do 21. 10. 2026'));
    const flyer = await new BillaPageProvider(asHttp(http)).resolve(
      SHOP_CONFIGS.billa,
    );

    expect(flyer).toMatchObject({
      flyerId: 'billa_2026-10-15_2026-10-21',
      pages: {
        kind: 'pdf',
        url: 'https://view.publitas.com/billa/letak.pdf?x=1&y=2',
      },
    });
  });

  it('puts the start of a flyer across New Year in the previous year', async () => {
    const http = fakeHttp();
    http.getText.mockResolvedValue(html('29. 12. do 4. 1. 2027'));
    const flyer = await new BillaPageProvider(asHttp(http)).resolve(
      SHOP_CONFIGS.billa,
    );

    expect(flyer.flyerId).toBe('billa_2026-12-29_2027-01-04');
  });
});
