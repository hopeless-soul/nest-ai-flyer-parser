import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_FLYER_HTTP_OPTIONS,
  FlyerHttpService,
  HttpRequestError,
} from './flyer-http.service';

describe('FlyerHttpService', () => {
  let server: Server;
  let base: string;
  let hits: Record<string, number>;
  let dir: string;

  const http = (overrides: Partial<typeof DEFAULT_FLYER_HTTP_OPTIONS> = {}) =>
    new FlyerHttpService({
      ...DEFAULT_FLYER_HTTP_OPTIONS,
      retryDelayMs: 1,
      ...overrides,
    });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '/';
      hits[path] = (hits[path] ?? 0) + 1;
      if (path === '/flaky' && hits[path] < 3)
        return void res.writeHead(503).end();
      if (path === '/flaky') return void res.end('ok after retries');
      if (path === '/missing') return void res.writeHead(404).end();
      if (path === '/agent') return void res.end(req.headers['user-agent']);
      if (path === '/file') return void res.end(Buffer.alloc(4096, 1));
      res.writeHead(500).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'flyer-http-'));
  });
  beforeEach(() => (hits = {}));
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it('sends browser headers', async () => {
    expect(await http().getText(`${base}/agent`)).toContain('Chrome/');
  });

  it('retries 5xx and then succeeds', async () => {
    expect(await http().getText(`${base}/flaky`)).toBe('ok after retries');
    expect(hits['/flaky']).toBe(3);
  });

  it('does not retry a 404', async () => {
    await expect(http().getText(`${base}/missing`)).rejects.toMatchObject({
      status: 404,
    });
    expect(hits['/missing']).toBe(1);
  });

  it('gives up after the configured retries', async () => {
    await expect(
      http({ retries: 1 }).getText(`${base}/broken`),
    ).rejects.toBeInstanceOf(HttpRequestError);
    expect(hits['/broken']).toBe(2);
  });

  it('streams a download to disk without leaving a .part file', async () => {
    const file = join(dir, 'pages', 'flyer.pdf');
    const result = await http().downloadToFile(`${base}/file`, file);

    expect(result.bytes).toBe(4096);
    expect((await readFile(file)).length).toBe(4096);
    expect(await readdir(join(dir, 'pages'))).toEqual(['flyer.pdf']);
  });

  it('rejects a download over maxDownloadBytes and cleans up', async () => {
    const file = join(dir, 'big', 'flyer.pdf');
    await expect(
      http({ maxDownloadBytes: 1000 }).downloadToFile(`${base}/file`, file),
    ).rejects.toThrow(/too large/);
    expect(await readdir(join(dir, 'big')).catch(() => [])).toEqual([]);
  });
});
